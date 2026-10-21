import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export function publicOrigin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTPS origin.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    /^(localhost|127\.|0\.|\[::1\])/.test(url.hostname) ||
    /\.(local|invalid|example|test)$/.test(url.hostname) ||
    ['example.com', 'example.org', 'example.net'].includes(url.hostname)
  ) {
    throw new Error(`${name} must be a real public HTTPS origin without a path or credentials.`);
  }
  return url.origin;
}
export function validateReleaseProfile(profile) {
  if (!profile || typeof profile !== 'object')
    throw new Error('Missing iOS release configuration.');
  if (!/^[A-Z0-9]{10}$/.test(profile.appleTeamId ?? ''))
    throw new Error('appleTeamId must be your 10-character Apple Developer team ID.');
  if (typeof profile.aiGamePacks !== 'boolean')
    throw new Error('Set aiGamePacks explicitly to true or false.');
  return {
    apiOrigin: publicOrigin(profile.apiOrigin, 'apiOrigin'),
    publicOrigin: publicOrigin(profile.publicOrigin ?? profile.apiOrigin, 'publicOrigin'),
    appleTeamId: profile.appleTeamId,
    aiGamePacks: profile.aiGamePacks,
  };
}

export async function checkReleaseBackend(profile, request = fetch) {
  async function get(path, origin = profile.apiOrigin) {
    const response = await request(`${origin}${path}`, {
      headers: { origin: 'capacitor://localhost' },
      signal: AbortSignal.timeout(12_000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(
        `${path} returned HTTP ${response.status}. Deploy the matching backend first.`,
      );
    if (
      origin === profile.apiOrigin &&
      response.headers.get('access-control-allow-origin') !== 'capacitor://localhost'
    ) {
      throw new Error(
        'The backend does not allow the iOS app origin. Check its CORS configuration.',
      );
    }
    return response;
  }
  const health = await (await get('/healthz')).json();
  if (health?.data?.status !== 'ok') throw new Error('Backend health check failed.');
  const config = (await (await get('/api/v1/app-config')).json()).data;
  if (!config?.publisherName || !config.reportsAvailable)
    throw new Error('Configure the publisher and in-app report service.');
  for (const key of ['privacyUrl', 'termsUrl', 'supportUrl']) {
    let url;
    try {
      url = new URL(config[key]);
    } catch {
      throw new Error(`The backend is missing ${key}.`);
    }
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error(`${key} must use HTTPS.`);
    publicOrigin(url.origin, key);
    const response = await request(url, { signal: AbortSignal.timeout(12_000), redirect: 'error' });
    if (!response.ok) throw new Error(`${key} is not reachable (HTTP ${response.status}).`);
  }
  const billing = (await (await get('/api/v1/billing/config')).json()).data;
  if (
    profile.aiGamePacks &&
    (!billing?.signInAvailable || !billing.purchasesAvailable || !billing.products?.length)
  ) {
    throw new Error(
      'AI game packs are enabled in this build, but Apple sign-in or purchases are not configured on the backend.',
    );
  }
  const player = await get('/player.html', profile.publicOrigin);
  if (!(await player.text()).includes('AUX'))
    throw new Error('The public URL does not serve the player app.');
  return { publisherName: config.publisherName, aiGamePacks: profile.aiGamePacks };
}

export function sourceFingerprint(root = repoRoot) {
  const hash = createHash('sha256');
  const visit = (file) => {
    if (!existsSync(file)) return;
    const entries = readdirSync(file, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = resolve(file, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        hash.update(relative(root, path));
        hash.update(readFileSync(path));
      }
    }
  };
  for (const directory of ['apps/web/src', 'apps/web/public', 'packages/shared/src'])
    visit(resolve(root, directory));
  for (const file of [
    'package-lock.json',
    'capacitor.config.ts',
    'apps/web/index.html',
    'apps/web/host.html',
    'apps/web/player.html',
  ]) {
    if (existsSync(resolve(root, file))) hash.update(readFileSync(resolve(root, file)));
  }
  return hash.digest('hex');
}
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', env });
  if (result.status !== 0) throw new Error(`${command} failed. Fix the error above and retry.`);
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0] ?? 'check';
  if (command === 'archive-check') {
    if (process.env.ACTION !== 'install') return;
    const file = resolve(repoRoot, 'ios/App/App/public/ios-build.json');
    const stamp = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    if (stamp?.releaseVerified !== true || stamp.sourceFingerprint !== sourceFingerprint()) {
      throw new Error(
        'iOS release assets are missing or stale. Run npm run ios:prepare before archiving.',
      );
    }
    if (process.env.DEVELOPMENT_TEAM !== stamp.appleTeamId)
      throw new Error('The selected signing team differs from ios.release.json.');
    return;
  }
  if (command === 'compile-check') {
    const env = {
      ...process.env,
      VITE_AUX_API_ORIGIN: 'https://build-check.invalid',
      VITE_AUX_PUBLIC_ORIGIN: 'https://build-check.invalid',
    };
    run('npm', ['run', 'build:mobile'], env);
    writeFileSync(
      resolve(repoRoot, 'apps/web/dist-mobile/ios-build.json'),
      JSON.stringify({ releaseVerified: false, sourceFingerprint: sourceFingerprint() }),
    );
    run('npx', ['cap', 'copy', 'ios'], { ...env, AUX_NATIVE_BUILD: '1' });
    return;
  }
  const profileFile = resolve(repoRoot, process.env.AUX_IOS_RELEASE_CONFIG ?? 'ios.release.json');
  if (!existsSync(profileFile))
    throw new Error(
      'Copy ios.release.example.json to ios.release.json and enter your public backend URL and Apple team ID.',
    );
  const profile = validateReleaseProfile(JSON.parse(readFileSync(profileFile, 'utf8')));
  await checkReleaseBackend(profile);
  console.log('iOS backend, public links and selected services are reachable.');
  if (command === 'check') return;
  if (command !== 'prepare')
    throw new Error('Expected check, prepare, compile-check or archive-check.');
  const env = {
    ...process.env,
    VITE_AUX_API_ORIGIN: profile.apiOrigin,
    VITE_AUX_PUBLIC_ORIGIN: profile.publicOrigin,
  };
  run('npm', ['run', 'build:mobile'], env);
  writeFileSync(
    resolve(repoRoot, 'apps/web/dist-mobile/ios-build.json'),
    JSON.stringify(
      {
        ...profile,
        releaseVerified: true,
        sourceFingerprint: sourceFingerprint(),
        checkedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  run('npx', ['cap', 'copy', 'ios'], { ...env, AUX_NATIVE_BUILD: '1' });
  // Public configuration only. Xcode keeps private signing keys in the user's Keychain.
  writeFileSync(
    resolve(repoRoot, 'ios/Release.local.xcconfig'),
    `DEVELOPMENT_TEAM = ${profile.appleTeamId}\n`,
  );
  console.log(
    'Prepared. Open ios/App/App.xcodeproj, select your iPhone or Any iOS Device, then Build or Archive.',
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`iOS setup: ${error.message}`);
    process.exitCode = 1;
  });
}
