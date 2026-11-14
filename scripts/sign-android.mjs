// Sign an already aligned release APK with the existing, privately stored identity.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const [input, signer, key, passwordFile] = process.argv.slice(2);
if (!input || !signer || !key || !passwordFile || !process.env.JAVA_HOME) throw new Error('Usage: JAVA_HOME=... node scripts/sign-android.mjs unsigned.apk apksigner.jar release.p12 password-file');
for (const file of [input, signer, key, passwordFile]) if (!existsSync(file)) throw new Error(`File not found: ${file}`);
const gradle = readFileSync('android/app/build.gradle', 'utf8');
const versionName = gradle.match(/versionName\s+'(\d+\.\d+\.\d+)'/)?.[1];
const versionCode = Number(gradle.match(/versionCode\s+(\d+)/)?.[1]);
if (!versionName || !Number.isSafeInteger(versionCode) || versionCode < 1) throw new Error('Invalid Android version');
const directory = path.resolve('release/android'); mkdirSync(directory, { recursive: true });
const file = `Okrug-${versionName}.apk`, output = path.join(directory, file);
if (existsSync(output)) throw new Error('This version is already signed; increment the Android version before releasing again');
const java = path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
function run(args) { const result = spawnSync(java, ['-jar', path.resolve(signer), ...args], { stdio: 'inherit', windowsHide: true }); if (result.error) throw result.error; if (result.status !== 0) throw new Error('APK signing or verification failed'); }
run(['sign', '--ks', path.resolve(key), '--ks-key-alias', 'okrug', '--ks-pass', `file:${path.resolve(passwordFile)}`, '--out', output, path.resolve(input)]);
run(['verify', '--verbose', output]);
const apk = readFileSync(output);
writeFileSync(path.join(directory, 'latest.json'), JSON.stringify({ versionCode, versionName, file, size: apk.length, sha256: createHash('sha256').update(apk).digest('hex') }, null, 2) + '\n');
console.log(`Signed Android package: ${output}`);
