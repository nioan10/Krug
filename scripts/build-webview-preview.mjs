// Preview builds use a separate app ID. A release build is staged locally and
// must be verified together with the intermediate Electron update before use.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('The WebView2 preview requires Windows.');
const root = process.cwd(), require = createRequire(import.meta.url);
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const release = process.argv.includes('--release');
const version = '0.2.0';
const product = release ? metadata.build.productName : 'Krug WebView Preview';
const base = path.resolve('.local');
await mkdir(base, { recursive: true });
const stage = await mkdtemp(path.join(base, release ? 'webview-release-' : 'webview-preview-'));
const app = path.join(stage, 'app');
await mkdir(app, { recursive: true });
// electron-builder places its elevation helper here even for prepackaged apps.
await mkdir(path.join(app, 'resources'), { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}); preview is in ${stage}`);
}
run('dotnet', ['build', 'desktop/webview/desktop/Krug.Desktop.csproj', '-c', 'Release', ...(release ? ['-p:KrugRelease=true'] : [])]);
run('dotnet', ['publish', 'desktop/capture/Krug.Capture.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', path.join(app, 'capture')]);
const output = 'desktop/webview/desktop/bin/Release/net48';
await cp(path.join(output, 'Krug.Desktop.exe'), path.join(app, `${product}.exe`));
await cp(path.join(output, 'Krug.Desktop.exe.config'), path.join(app, `${product}.exe.config`));
for (const name of ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll']) await cp(path.join(output, name), path.join(app, name));
const licenses = path.join(app, 'licenses'); await mkdir(licenses);
await cp('desktop/webview/licenses/NAudio.txt', path.join(licenses, 'NAudio.txt'));
const packages = process.env.NUGET_PACKAGES || path.join(homedir(), '.nuget', 'packages');
const webviewPackage = path.join(packages, 'microsoft.web.webview2', '1.0.4314.35');
for (const name of ['LICENSE.txt', 'NOTICE.txt']) await cp(path.join(webviewPackage, name), path.join(licenses, `WebView2-${name}`));
const deps = JSON.parse(await readFile(path.join(app, 'capture', 'Krug.Capture.deps.json'), 'utf8'));
const runtime = Object.keys(deps.libraries).find(key => key.startsWith('runtimepack.Microsoft.NETCore.App.Runtime.win-x64/'))?.split('/')[1];
if (!runtime) throw new Error('Cannot determine the bundled .NET runtime license version.');
for (const name of ['LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT']) await cp(path.join(packages, 'microsoft.netcore.app.runtime.win-x64', runtime, name), path.join(licenses, `dotnet-${name}`));
await mkdir(path.join(stage, 'public'), { recursive: true });
await cp('public/icons', path.join(stage, 'public/icons'), { recursive: true });
if (release) {
  run('dotnet', ['build', 'desktop/session-helper/Krug.SessionHelper.csproj', '-c', 'Release']);
  const prerequisites = path.join(stage, 'prerequisites'); await mkdir(prerequisites);
  for (const name of ['Krug.SessionHelper.exe', 'Krug.SessionHelper.exe.config', 'Microsoft.Web.WebView2.Core.dll', 'WebView2Loader.dll'])
    await cp(path.join('desktop/session-helper/bin/Release/net48', name), path.join(prerequisites, name));
  await writeFile(path.join(stage, 'runtime-check.nsh'), `!macro customInit\n  InitPluginsDir\n  SetOutPath "$PLUGINSDIR"\n  File "\${PROJECT_DIR}\\prerequisites\\Krug.SessionHelper.exe"\n  File "\${PROJECT_DIR}\\prerequisites\\Krug.SessionHelper.exe.config"\n  File "\${PROJECT_DIR}\\prerequisites\\Microsoft.Web.WebView2.Core.dll"\n  File "\${PROJECT_DIR}\\prerequisites\\WebView2Loader.dll"\n  nsExec::ExecToStack '\"$PLUGINSDIR\\Krug.SessionHelper.exe\" --check-runtime'\n  Pop $0\n  StrCmp $0 0 +4\n  IfSilent +2 0\n  MessageBox MB_OK|MB_ICONEXCLAMATION "Для Округа требуется Microsoft Edge WebView2 Runtime версии 131 или новее. Обновите WebView2 и повторите установку."\n  Abort\n!macroend\n`);
}
await writeFile(path.join(stage, 'package.json'), JSON.stringify({
  name: release ? metadata.name : 'krug-webview-preview', version, private: true,
  description: 'Isolated Krug WebView2 preview',
  build: {
    appId: release ? metadata.build.appId : 'test.krug.webview.preview', productName: product,
    artifactName: release ? 'Krug-Setup-${version}.${ext}' : 'Krug-WebView-Preview-${version}.${ext}', electronVersion: metadata.devDependencies.electron,
    directories: { output: 'release' }, publish: release ? metadata.build.publish : [],
    win: { target: 'nsis', icon: 'public/icons/icon-512.png', signExecutable: false },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, ...(release ? { include: 'runtime-check.nsh' } : {}) },
  },
}, null, 2));
console.log(`Local ${release ? 'release candidate' : 'isolated preview'} files: ${stage}`);
run(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), '--projectDir', stage, '--prepackaged', app, '--win', 'nsis', '--x64', '--publish', 'never']);
if (release) {
  const manifest = path.join(stage, 'release', 'latest.yml');
  const text = await readFile(manifest, 'utf8');
  if (!new RegExp(`^version: ${version.replaceAll('.', '\\.')}\\s*$`, 'm').test(text) || !text.includes(`path: Krug-Setup-${version}.exe`)) throw new Error('Unexpected release manifest.');
  await writeFile(manifest, `${text.trimEnd()}\nkrugRuntime: webview2\n`);
}
