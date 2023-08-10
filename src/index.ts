import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import { getOctokit } from '@actions/github';
import { promises as fs, constants } from 'fs';
import { basename, dirname, join } from 'path';
import { satisfies } from 'semver';

function getTargets(): string[] {
  const { arch, platform } = process;
  if (arch === 'x64') {
    if (platform === 'linux') {
      return ['x86_64-unknown-linux-musl', 'x86_64-unknown-linux-gnu'];
    } else if (platform === 'darwin') {
      return ['x86_64-apple-darwin'];
    } else if (platform === 'win32') {
      return ['x86_64-pc-windows-msvc'];
    }
  } else if (arch === 'arm64') {
    if (platform === 'linux') {
      return ['aarch64-unknown-linux-musl', 'aarch64-unknown-linux-gnu'];
    } else if (platform === 'darwin') {
      return ['aarch64-apple-darwin'];
    }
  }
  throw new Error(`Failed to determine any valid targets: arch=${arch}, platform=${platform}`);
}

export interface Options {
  auth: any;
}

export interface Crate {
  owner: string;
  name: string;
  version_spec?: string;
  bin?: string;
}

export interface InstalledCrate {
  owner: string;
  name: string;
  version: string;
  dir: string;
  bin?: string;
}

interface Release {
  version: string;
  download_url: string;
}

async function getRelease(crate: Crate, options?: Options): Promise<Release> {
  const targets = getTargets();
  const { owner, name, version_spec } = crate;
  const octokit = getOctokit(options?.auth);
  return octokit.paginate(octokit.rest.repos.listReleases, { owner, repo: name }, (response, done) => {
    const releases = response.data.map((release) => {
      const asset = release.assets.find((asset) => targets.some((target) => asset.name.includes(target)));
      if (asset) {
        return {
          version: release.tag_name.replace(/^v/, ''),
          download_url: asset.browser_download_url,
        };
      }
    })
    .filter((release) => Boolean(release))
    .filter((release) => release && version_spec ? satisfies(release.version, version_spec) : true);
    if (releases.length > 0) {
      done();
    }
    return releases;
  }).then((releases) => {
    const release = releases.find((release) => release != null);
    if (release === undefined) {
      throw new Error(`no releases for ${name} matching version specifier ${version_spec}`);
    }
    return release;
  });
}

async function handleBadBinaryPermissions(crate: Crate, dir: string): Promise<void> {
  const { name, bin } = crate;
  if (process.platform !== 'win32') {
    const findBin = async () => {
      const files = await fs.readdir(dir);
      for await (const file of files) {
        if (file.toLowerCase() === name.toLowerCase()) {
          return file;
        }
      }
      return name;
    };
    const binary = join(dir, bin ? bin : await findBin());
    try {
      await fs.access(binary, constants.X_OK);
    } catch {
      await fs.chmod(binary, 0o755);
      core.debug(`Fixed file permissions (-> 0o755) for ${binary}`);
    }
  }
}

export async function checkOrInstallCrate(crate: Crate, options?: Options): Promise<InstalledCrate> {
  const { name, version_spec } = crate;
  let dir = tc.find(name, version_spec || '*');
  if (!dir) {
    const { version, download_url } = await getRelease(crate, options);
    const artifact = await tc.downloadTool(download_url);
    core.debug(`Successfully downloaded ${name} v${version}`);
    let extractDir;
    if (download_url.endsWith('.zip')) {
      extractDir = await tc.extractZip(artifact);
    } else {
      extractDir = await tc.extractTar(artifact);
    }
    core.debug(`Successfully extracted archive for ${name} v${version}`);
    const files = await fs.readdir(extractDir);
    if (files.length === 1) {
      const maybeDir = join(extractDir, files[0]);
      if ((await fs.lstat(maybeDir)).isDirectory()) {
        extractDir = maybeDir;
      }
    }
    dir = await tc.cacheDir(extractDir, name, version);
    await handleBadBinaryPermissions(crate, dir);
  }
  const version = basename(dirname(dir));
  return { ...crate, version, dir };
}

async function main() {
  try {
    const owner = core.getInput('owner', { required: true });
    const name = core.getInput('name', { required: true });
    const githubToken = core.getInput('github-token');
    const version_spec = core.getInput('version');
    const crate = await checkOrInstallCrate({ owner, name, version_spec }, { auth: githubToken });
    core.addPath(crate.dir);
    core.info(`Successfully setup ${crate.name} v${crate.version}`);
  } catch (err) {
    if (err instanceof Error) {
      core.setFailed(err.message);
    }
  }
}

main();
