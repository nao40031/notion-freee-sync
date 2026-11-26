import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, mkdir, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 50;
const safeName = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);
const encoded = script => Buffer.from(script, "utf16le").toString("base64");

function invokePowerShell(script, input, code) {
  if (process.platform !== "win32") throw Object.assign(Error("windows_credential_store_platform_required"), { code: "windows_credential_store_platform_required" });
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(script)], {
      windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
      env: Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH"]
        .filter(key => process.env[key]).map(key => [key, process.env[key]])),
    });
    const output = [];
    child.stdout.on("data", part => output.push(part));
    child.on("error", () => rejectPromise(Object.assign(Error(code), { code })));
    child.on("close", status => status === 0 ? resolvePromise(Buffer.concat(output).toString("utf8").trim()) : rejectPromise(Object.assign(Error(code), { code })));
    child.stdin.on("error", () => {});
    child.stdin.end(input, "utf8");
  });
}

const protectScript = `[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; $plain=[Console]::In.ReadToEnd(); $secure=ConvertTo-SecureString -String $plain -AsPlainText -Force; ConvertFrom-SecureString -SecureString $secure`;
const unprotectScript = `[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; $encrypted=[Console]::In.ReadToEnd().Trim(); $secure=ConvertTo-SecureString -String $encrypted; $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }`;
const aclScript = `[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; $path=[Console]::In.ReadToEnd().Trim(); if(-not (Test-Path -LiteralPath $path -PathType Container)){New-Item -ItemType Directory -Force -Path $path|Out-Null}; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit; $rights=[Security.AccessControl.FileSystemRights]::FullControl; $acl=Get-Acl -LiteralPath $path; $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); $ok=$acl.AreAccessRulesProtected -and $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid.Value -and $rules[0].AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ($rules[0].FileSystemRights -band $rights) -eq $rights -and $rules[0].InheritanceFlags -eq $inherit -and $rules[0].PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None; if(-not $ok){$acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $acl}; $verified=Get-Acl -LiteralPath $path; $verifiedRules=@($verified.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); if(-not $verified.AreAccessRulesProtected -or $verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $verifiedRules.Count -ne 1 -or $verifiedRules[0].IdentityReference.Value -ne $sid.Value){throw 'credential_acl_verification_failed'}`;

export const windowsDpapi = Object.freeze({
  protect: value => invokePowerShell(protectScript, value, "windows_credential_protect_failed"),
  unprotect: value => invokePowerShell(unprotectScript, value, "windows_credential_unprotect_failed"),
  secureDirectory: path => invokePowerShell(aclScript, resolve(path), "windows_credential_acl_failed"),
});

/** Windows CurrentUser DPAPI store compatible with createOAuthTokenProvider.
 * Client secrets should come from the host's secret configuration, not this token record. */
export class WindowsDpapiTokenStore {
  constructor({ appName = "notion-freee-sync", profile = "default", root, dpapi = windowsDpapi,
    lockTimeoutMs = LOCK_TIMEOUT_MS, pollMs = LOCK_POLL_MS, now = Date.now, sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms)) } = {}) {
    if (!safeName(appName) || !safeName(profile) || !dpapi || typeof dpapi.protect !== "function" || typeof dpapi.unprotect !== "function" || typeof dpapi.secureDirectory !== "function") throw Error("windows_credential_store_config_invalid");
    this.root = resolve(root || join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), appName, profile));
    this.file = join(this.root, "oauth-token.dpapi");
    this.lockPath = join(this.root, "oauth-token.lock");
    this.dpapi = dpapi; this.lockTimeoutMs = lockTimeoutMs; this.pollMs = pollMs; this.now = now; this.sleep = sleep;
  }
  async ensureRoot() {
    await mkdir(dirname(this.root), { recursive: true });
    try { const entry = await lstat(this.root); if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error("unsafe_path"); }
    catch (error) { if (error?.code !== "ENOENT") throw Error("windows_credential_store_path_invalid"); }
    await this.dpapi.secureDirectory(this.root);
  }
  async load() {
    let encrypted;
    try { encrypted = await readFile(this.file, "utf8"); }
    catch (error) { if (error?.code === "ENOENT") return null; throw Error("windows_credential_store_read_failed"); }
    let value;
    try { value = JSON.parse(await this.dpapi.unprotect(encrypted)); }
    catch { throw Error("windows_credential_store_decrypt_failed"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("windows_credential_store_record_invalid");
    return value;
  }
  async save(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw Error("windows_credential_store_record_invalid");
    await this.ensureRoot();
    const ciphertext = await this.dpapi.protect(JSON.stringify(record));
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(`${ciphertext}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.file);
    } catch { try { await unlink(temporary); } catch {} throw Error("windows_credential_store_write_failed"); }
  }
  async withLock(action) {
    if (typeof action !== "function") throw Error("windows_credential_lock_action_invalid");
    await this.ensureRoot();
    const owner = randomUUID(), started = this.now();
    let handle;
    for (;;) {
      try {
        handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ owner, pid: process.pid, acquired_at: new Date(this.now()).toISOString() }), "utf8");
        await handle.sync();
        break;
      } catch (error) {
        if (handle) {
          try { await handle.close(); } catch {}
          try { const current = JSON.parse(await readFile(this.lockPath, "utf8")); if (current.owner === owner) await unlink(this.lockPath); } catch {}
          throw Error("windows_credential_lock_write_failed");
        }
        if (error?.code !== "EEXIST") throw Error("windows_credential_lock_unavailable");
        if (this.now() - started >= this.lockTimeoutMs) throw Error("windows_credential_lock_timeout");
        await this.sleep(this.pollMs);
      }
    }
    try { return await action(); }
    finally {
      try { await handle.close(); } catch {}
      // Never clear a lock that was replaced by another process. Stale locks are
      // deliberately left for an operator to inspect rather than guessed away.
      try { const current = JSON.parse(await readFile(this.lockPath, "utf8")); if (current.owner === owner) await unlink(this.lockPath); } catch {}
    }
  }
}
