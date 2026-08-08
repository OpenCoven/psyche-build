import { describe, expect, it } from 'vitest';
import { normalizeGitHubRemote, orderGitHubRemotes, type GitHubRemote } from '../src/github/remotes.js';

function createRemote(name: string, rawUrl: string, host = 'github.com'): GitHubRemote {
  return {
    name,
    rawUrl,
    repository: {
      host,
      owner: 'OpenCoven',
      name: `${name}-repo`,
      url: `https://${host}/OpenCoven/${name}-repo`,
    },
  };
}

describe('normalizeGitHubRemote', () => {
  it('normalizes supported GitHub remote URL formats to gh hostname identities', () => {
    const nbspName = '\u00a0origin\u00a0';
    const unicodeName = '遠端-é';

    expect(normalizeGitHubRemote('origin', 'https://GitHub.COM/OpenCoven/psyche-build.git')).toEqual({
      name: 'origin',
      rawUrl: 'https://GitHub.COM/OpenCoven/psyche-build.git',
      repository: {
        host: 'github.com',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://github.com/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote(nbspName, 'https://github.com/OpenCoven/psyche-build.git')).toEqual({
      name: nbspName,
      rawUrl: 'https://github.com/OpenCoven/psyche-build.git',
      repository: {
        host: 'github.com',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://github.com/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote(unicodeName, 'https://github.com/OpenCoven/psyche-build.git')).toEqual({
      name: unicodeName,
      rawUrl: 'https://github.com/OpenCoven/psyche-build.git',
      repository: {
        host: 'github.com',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://github.com/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote('origin', 'git@github.com:OpenCoven/psyche-build.git')).toEqual({
      name: 'origin',
      rawUrl: 'git@github.com:OpenCoven/psyche-build.git',
      repository: {
        host: 'github.com',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://github.com/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote('enterprise-https', 'https://ghe.example.test:443/OpenCoven/psyche-build.git')).toEqual({
      name: 'enterprise-https',
      rawUrl: 'https://ghe.example.test:443/OpenCoven/psyche-build.git',
      repository: {
        host: 'ghe.example.test',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://ghe.example.test/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote('enterprise-https-rooted', 'https://ghe.example.test./OpenCoven/psyche-build.git')).toEqual({
      name: 'enterprise-https-rooted',
      rawUrl: 'https://ghe.example.test./OpenCoven/psyche-build.git',
      repository: {
        host: 'ghe.example.test',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://ghe.example.test/OpenCoven/psyche-build',
      },
    });

    expect(
      normalizeGitHubRemote('enterprise-ssh', 'ssh://git@GHE.Example.Test:2222/Open%43oven/psyche%2Dbuild%2Egit'),
    ).toEqual({
      name: 'enterprise-ssh',
      rawUrl: 'ssh://git@GHE.Example.Test:2222/Open%43oven/psyche%2Dbuild%2Egit',
      repository: {
        host: 'ghe.example.test',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://ghe.example.test/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote('enterprise-ssh-rooted', 'ssh://git@ghe.example.test.:2222/OpenCoven/psyche-build.git')).toEqual({
      name: 'enterprise-ssh-rooted',
      rawUrl: 'ssh://git@ghe.example.test.:2222/OpenCoven/psyche-build.git',
      repository: {
        host: 'ghe.example.test',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://ghe.example.test/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote('github-https-443', 'https://github.com:443/OpenCoven/psyche-build.git')).toEqual({
      name: 'github-https-443',
      rawUrl: 'https://github.com:443/OpenCoven/psyche-build.git',
      repository: {
        host: 'github.com',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://github.com/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote('github-rooted', 'https://github.com./OpenCoven/psyche-build.git')).toEqual({
      name: 'github-rooted',
      rawUrl: 'https://github.com./OpenCoven/psyche-build.git',
      repository: {
        host: 'github.com',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://github.com/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote('github-ssh-default', 'ssh://git@github.com/OpenCoven/psyche-build.git')).toEqual({
      name: 'github-ssh-default',
      rawUrl: 'ssh://git@github.com/OpenCoven/psyche-build.git',
      repository: {
        host: 'github.com',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://github.com/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote('github-ssh-arbitrary-port', 'ssh://git@github.com:2222/OpenCoven/psyche-build.git')).toEqual({
      name: 'github-ssh-arbitrary-port',
      rawUrl: 'ssh://git@github.com:2222/OpenCoven/psyche-build.git',
      repository: {
        host: 'github.com',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://github.com/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote('ssh-github-arbitrary-port', 'ssh://git@ssh.github.com:2022/OpenCoven/psyche-build.git')).toEqual({
      name: 'ssh-github-arbitrary-port',
      rawUrl: 'ssh://git@ssh.github.com:2022/OpenCoven/psyche-build.git',
      repository: {
        host: 'github.com',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://github.com/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote('scp-rooted', 'git@ghe.example.test.:OpenCoven/psyche-build.git')).toEqual({
      name: 'scp-rooted',
      rawUrl: 'git@ghe.example.test.:OpenCoven/psyche-build.git',
      repository: {
        host: 'ghe.example.test',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://ghe.example.test/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote('double-git', 'https://ghe.example.test/OpenCoven/psyche-build.git.git')).toEqual({
      name: 'double-git',
      rawUrl: 'https://ghe.example.test/OpenCoven/psyche-build.git.git',
      repository: {
        host: 'ghe.example.test',
        owner: 'OpenCoven',
        name: 'psyche-build.git',
        url: 'https://ghe.example.test/OpenCoven/psyche-build.git',
      },
    });
  });

  it('canonicalizes IDN authorities for gh hostnames across HTTPS, ssh, and SCP remotes', () => {
    const unicodeIdn = normalizeGitHubRemote('unicode-idn', 'https://BÜCHER.example/OpenCoven/psyche-build.git');
    const punycodeIdn = normalizeGitHubRemote('punycode-idn', 'https://xn--bcher-kva.example/OpenCoven/psyche-build.git');
    const sshUnicodeIdn = normalizeGitHubRemote('ssh-unicode-idn', 'ssh://git@BÜCHER.example/OpenCoven/psyche-build.git');
    const scpUnicodeIdn = normalizeGitHubRemote('scp-unicode-idn', 'git@BÜCHER.example:OpenCoven/psyche-build.git');

    expect(unicodeIdn?.repository).toEqual({
      host: 'xn--bcher-kva.example',
      owner: 'OpenCoven',
      name: 'psyche-build',
      url: 'https://xn--bcher-kva.example/OpenCoven/psyche-build',
    });
    expect(punycodeIdn?.repository).toEqual(unicodeIdn?.repository);
    expect(sshUnicodeIdn?.repository).toEqual(unicodeIdn?.repository);
    expect(scpUnicodeIdn?.repository).toEqual(unicodeIdn?.repository);
  });

  it('rejects unsupported or malformed remote names and URLs', () => {
    const invalidInputs: Array<[string, string]> = [
      ['', 'https://github.com/OpenCoven/psyche-build.git'],
      ['   ', 'https://github.com/OpenCoven/psyche-build.git'],
      [' origin', 'https://github.com/OpenCoven/psyche-build.git'],
      ['origin ', 'https://github.com/OpenCoven/psyche-build.git'],
      ['\torigin', 'https://github.com/OpenCoven/psyche-build.git'],
      ['origin\t', 'https://github.com/OpenCoven/psyche-build.git'],
      ['origin\u000b', 'https://github.com/OpenCoven/psyche-build.git'],
      ['origin\u0085', 'https://github.com/OpenCoven/psyche-build.git'],
      ['origin\u2028', 'https://github.com/OpenCoven/psyche-build.git'],
      ['origin\u2029', 'https://github.com/OpenCoven/psyche-build.git'],
      ['origin\u202E', 'https://github.com/OpenCoven/psyche-build.git'],
      ['ori\ngin', 'https://github.com/OpenCoven/psyche-build.git'],
      ['origin', ' https://github.com/OpenCoven/psyche-build.git'],
      ['origin', 'https://github.com/OpenCoven/psyche-build.git '],
      ['origin', 'https://github.com/Open Coven/psyche-build.git'],
      ['origin', 'https://github.com/Open%20Coven/psyche-build.git'],
      ['origin', 'https://github.com/Open%09Coven/psyche-build.git'],
      ['origin', 'https://github.com/Open%0ACoven/psyche-build.git'],
      ['origin', 'https://github.com/OpenCoven/psyche build.git'],
      ['origin', 'https://github.com/OpenCoven/psyche%20build.git'],
      ['origin', 'https://github.com/OpenCoven/psyche%09build.git'],
      ['origin', 'https://github.com/OpenCoven/psyche-build.git#frag'],
      ['origin', 'https://github.com/OpenCoven/psyche-build.git?view=1'],
      ['origin', `https://${'user:pw@'}github.com/OpenCoven/psyche-build.git`],
      ['origin', 'https://github.com:8443/OpenCoven/psyche-build.git'],
      ['origin', 'https://[2001:db8::1]:443/OpenCoven/psyche-build.git'],
      ['origin', 'https://ghe.example.test:8443/OpenCoven/psyche-build.git'],
      ['origin', 'https://127.0.0.1/OpenCoven/psyche-build.git'],
      ['origin', 'https://localhost/OpenCoven/psyche-build.git'],
      ['origin', 'https://ghe..example.test/OpenCoven/psyche-build.git'],
      ['origin', 'https://-ghe.example.test/OpenCoven/psyche-build.git'],
      ['origin', 'https://ghe.example-.test/OpenCoven/psyche-build.git'],
      ['origin', 'https://ghe%2Eexample.test/OpenCoven/psyche-build.git'],
      ['origin', 'https://ghe.example.test\\OpenCoven/psyche-build.git'],
      ['origin', 'https://ssh.github.com/OpenCoven/psyche-build.git'],
      ['origin', 'https://ghe.example.test/./psyche-build.git'],
      ['origin', 'https://ghe.example.test/../psyche-build.git'],
      ['origin', 'https://ghe.example.test/%2e/psyche-build.git'],
      ['origin', 'https://ghe.example.test/%2E%2E/psyche-build.git'],
      ['origin', 'https://ghe.example.test/Open%2Fcoven/psyche-build.git'],
      ['origin', 'https://ghe.example.test/OpenCoven/psyche%2Fbuild.git'],
      ['origin', 'https://ghe.example.test/OpenCoven/psyche%5Cbuild.git'],
      ['origin', 'https://ghe.example.test/Open%ZZoven/psyche-build.git'],
      ['origin', 'https://ghe.example.test/OpenCoven/psyche-build%ZZ.git'],
      ['origin', '******github.com/OpenCoven/psyche-build.git'],
      ['origin', 'http://github.com/OpenCoven/psyche-build.git'],
      ['origin', 'git://github.com/OpenCoven/psyche-build.git'],
      ['origin', 'file:///Users/buns/repo'],
      ['origin', '/Users/buns/repo'],
      ['origin', '../repo'],
      ['origin', 'git@github.com:OpenCoven'],
      ['origin', 'git@github.com:Open Coven/psyche-build.git'],
      ['origin', 'git@github.com:Open%20Coven/psyche-build.git'],
      ['origin', 'git@github.com:OpenCoven/psyche build.git'],
      ['origin', 'git@github.com:OpenCoven/psyche%20build.git'],
      ['origin', 'git@evil@github.com:OpenCoven/psyche-build.git'],
      ['origin', 'git@github\\com:OpenCoven/psyche-build.git'],
      ['origin', 'git@[2001:db8::1]:OpenCoven/psyche-build.git'],
      ['origin', 'git@127.0.0.1:OpenCoven/psyche-build.git'],
      ['origin', 'git@localhost:OpenCoven/psyche-build.git'],
      ['origin', 'git@ghe..example.test:OpenCoven/psyche-build.git'],
      ['origin', 'git@ghe.example.test.:./psyche-build.git'],
      ['origin', 'git@ghe%2Eexample.test:OpenCoven/psyche-build.git'],
      ['origin', 'git@ssh.github.com:OpenCoven/psyche-build.git'],
      ['origin', 'git@github.com:OpenCoven/psyche-build.git?view=1'],
      ['origin', 'ssh://git@ghe.example.test/OpenCoven'],
      ['origin', 'ssh://git@[2001:db8::1]:2222/OpenCoven/psyche-build.git'],
      ['origin', 'ssh://git@127.0.0.1/OpenCoven/psyche-build.git'],
      ['origin', 'ssh://git@localhost/OpenCoven/psyche-build.git'],
      ['origin', 'ssh://git@ghe..example.test/OpenCoven/psyche-build.git'],
      ['origin', 'ssh://git@ghe%2Eexample.test/OpenCoven/psyche-build.git'],
      ['origin', 'ssh://git@ghe.example.test\\OpenCoven/psyche-build.git'],
      ['origin', 'ssh://git@ghe.example.test/./psyche-build.git'],
      ['origin', 'ssh://git@ghe.example.test/../psyche-build.git'],
      ['origin', 'ssh://git@ghe.example.test/%2e/psyche-build.git'],
      ['origin', 'ssh://git@ghe.example.test/%2E%2E/psyche-build.git'],
      ['origin', 'ssh://git@ghe.example.test/Open Coven/psyche-build.git'],
      ['origin', 'ssh://git@ghe.example.test/Open%20Coven/psyche-build.git'],
      ['origin', 'ssh://git@ghe.example.test/OpenCoven/psyche build.git'],
      ['origin', 'ssh://git@ghe.example.test/OpenCoven/psyche%20build.git'],
      ['origin', 'https://github.com/OpenCoven'],
      ['origin', 'https://github.com/OpenCoven/psyche-build/issues'],
      ['origin', 'https://github.com/OpenCoven/.git'],
      ['origin', 'https://github.com/OpenCoven/../psyche-build'],
      ['origin', 'ssh://other@ghe.example.test/OpenCoven/psyche-build.git'],
      ['origin', `ssh://${'git:pw@'}ghe.example.test/OpenCoven/psyche-build.git`],
      ['origin', 'ssh://git@ghe.example.test/OpenCoven/psyche-build.git#frag'],
    ];

    for (const [name, rawUrl] of invalidInputs) {
      expect(normalizeGitHubRemote(name, rawUrl)).toBeNull();
    }
  });

  it('rejects enterprise remotes with invalid explicit ports', () => {
    const invalidPorts = ['0', '022', '65536', '99999', '+22', '-22', '22.0', '22a', ' 22'];

    for (const port of invalidPorts) {
      expect(normalizeGitHubRemote(
        'https-port',
        `https://ghe.example.test:${port}/OpenCoven/psyche-build.git`,
      )).toBeNull();

      expect(normalizeGitHubRemote(
        'ssh-port',
        `ssh://git@ghe.example.test:${port}/OpenCoven/psyche-build.git`,
      )).toBeNull();
    }
  });
});

describe('orderGitHubRemotes', () => {
  it('puts upstream first, then origin, then remaining remotes in lexical name order', () => {
    const remotes = [
      createRemote('mirror', 'https://github.com/OpenCoven/mirror-repo.git'),
      createRemote('origin', 'https://github.com/OpenCoven/origin-repo.git'),
      createRemote('upstream', 'https://github.com/OpenCoven/upstream-repo.git'),
      createRemote('alpha', 'https://github.com/OpenCoven/alpha-repo.git'),
    ];

    const ordered = orderGitHubRemotes(remotes, 'upstream');

    expect(ordered.map((remote) => remote.name)).toEqual(['upstream', 'origin', 'alpha', 'mirror']);
    expect(remotes.map((remote) => remote.name)).toEqual(['mirror', 'origin', 'upstream', 'alpha']);
    expect(ordered).not.toBe(remotes);
  });

  it('puts origin first when there is no usable upstream remote', () => {
    const remotes = [
      createRemote('zeta', 'https://github.com/OpenCoven/zeta-repo.git'),
      createRemote('origin', 'https://github.com/OpenCoven/origin-repo.git'),
      createRemote('alpha', 'https://github.com/OpenCoven/alpha-repo.git'),
    ];

    expect(orderGitHubRemotes(remotes, null).map((remote) => remote.name)).toEqual([
      'origin',
      'alpha',
      'zeta',
    ]);

    expect(orderGitHubRemotes(remotes, 'missing').map((remote) => remote.name)).toEqual([
      'origin',
      'alpha',
      'zeta',
    ]);
  });

  it('deduplicates duplicate remote names by first occurrence before ordering', () => {
    const firstOrigin = createRemote('origin', 'https://github.com/OpenCoven/first-origin.git');
    const secondOrigin = createRemote('origin', 'https://github.com/OpenCoven/second-origin.git');
    const remotes = [
      createRemote('backup', 'https://github.com/OpenCoven/backup-repo.git'),
      secondOrigin,
      firstOrigin,
      createRemote('upstream', 'https://github.com/OpenCoven/upstream-repo.git'),
    ];

    const ordered = orderGitHubRemotes(remotes, 'upstream');

    expect(ordered.map((remote) => [remote.name, remote.rawUrl])).toEqual([
      ['upstream', 'https://github.com/OpenCoven/upstream-repo.git'],
      ['origin', 'https://github.com/OpenCoven/second-origin.git'],
      ['backup', 'https://github.com/OpenCoven/backup-repo.git'],
    ]);
  });

  it('uses deterministic UTF-16 ordering for Unicode remote names', () => {
    const remotes = [
      createRemote('😀-remote', 'https://github.com/OpenCoven/emoji-repo.git'),
      createRemote('éclair', 'https://github.com/OpenCoven/eclair-repo.git'),
      createRemote('zeta', 'https://github.com/OpenCoven/zeta-repo.git'),
      createRemote('origin', 'https://github.com/OpenCoven/origin-repo.git'),
    ];

    expect(orderGitHubRemotes(remotes, null).map((remote) => remote.name)).toEqual([
      'origin',
      'zeta',
      'éclair',
      '😀-remote',
    ]);
  });
});
