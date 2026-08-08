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
  it('normalizes supported GitHub remote URL formats', () => {
    expect(normalizeGitHubRemote(' origin ', 'https://GitHub.COM/OpenCoven/psyche-build.git')).toEqual({
      name: 'origin',
      rawUrl: 'https://GitHub.COM/OpenCoven/psyche-build.git',
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

    expect(normalizeGitHubRemote('upstream', 'ssh://git@ghe.example.test/OpenCoven/psyche-build.git')).toEqual({
      name: 'upstream',
      rawUrl: 'ssh://git@ghe.example.test/OpenCoven/psyche-build.git',
      repository: {
        host: 'ghe.example.test',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://ghe.example.test/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote('enterprise', 'https://ghe.example.test/OpenCoven/psyche-build')).toEqual({
      name: 'enterprise',
      rawUrl: 'https://ghe.example.test/OpenCoven/psyche-build',
      repository: {
        host: 'ghe.example.test',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://ghe.example.test/OpenCoven/psyche-build',
      },
    });

    expect(
      normalizeGitHubRemote('enterprise-ssh', 'ssh://git@GHE.Example.Test:2222/OpenCoven/psyche-build.git'),
    ).toEqual({
      name: 'enterprise-ssh',
      rawUrl: 'ssh://git@GHE.Example.Test:2222/OpenCoven/psyche-build.git',
      repository: {
        host: 'ghe.example.test:2222',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://ghe.example.test:2222/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote('enterprise-ssh-22', 'ssh://git@ghe.example.test:22/OpenCoven/psyche-build.git')).toEqual({
      name: 'enterprise-ssh-22',
      rawUrl: 'ssh://git@ghe.example.test:22/OpenCoven/psyche-build.git',
      repository: {
        host: 'ghe.example.test:22',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://ghe.example.test:22/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote('enterprise-https-443', 'https://ghe.example.test:443/OpenCoven/psyche-build.git')).toEqual({
      name: 'enterprise-https-443',
      rawUrl: 'https://ghe.example.test:443/OpenCoven/psyche-build.git',
      repository: {
        host: 'ghe.example.test:443',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://ghe.example.test:443/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote('enterprise-https-8443', 'https://GHE.Example.Test:8443/OpenCoven/psyche-build.git')).toEqual({
      name: 'enterprise-https-8443',
      rawUrl: 'https://GHE.Example.Test:8443/OpenCoven/psyche-build.git',
      repository: {
        host: 'ghe.example.test:8443',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://ghe.example.test:8443/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote('enterprise-https-65535', 'https://ghe.example.test:65535/OpenCoven/psyche-build.git')).toEqual({
      name: 'enterprise-https-65535',
      rawUrl: 'https://ghe.example.test:65535/OpenCoven/psyche-build.git',
      repository: {
        host: 'ghe.example.test:65535',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://ghe.example.test:65535/OpenCoven/psyche-build',
      },
    });
  });

  it('rejects unsupported or malformed remote names and URLs', () => {
    const invalidInputs: Array<[string, string]> = [
      ['', 'https://github.com/OpenCoven/psyche-build.git'],
      ['   ', 'https://github.com/OpenCoven/psyche-build.git'],
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
      ['origin', 'https://github.com:443/OpenCoven/psyche-build.git'],
      ['origin', 'https://github.com:8443/OpenCoven/psyche-build.git'],
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
      ['origin', 'ssh://git@ghe.example.test/OpenCoven'],
      ['origin', 'ssh://git@github.com:22/OpenCoven/psyche-build.git'],
      ['origin', 'ssh://git@github.com:2222/OpenCoven/psyche-build.git'],
      ['origin', 'ssh://git@ghe.example.test/Open Coven/psyche-build.git'],
      ['origin', 'ssh://git@ghe.example.test/Open%20Coven/psyche-build.git'],
      ['origin', 'ssh://git@ghe.example.test/OpenCoven/psyche build.git'],
      ['origin', 'ssh://git@ghe.example.test/OpenCoven/psyche%20build.git'],
      ['origin', 'https://github.com/OpenCoven'],
      ['origin', 'https://github.com/OpenCoven/psyche-build/issues'],
      ['origin', 'https://github.com/OpenCoven/.git'],
      ['origin', 'https://github.com/OpenCoven/psyche-build.git.git'],
      ['origin', 'https://github.com/OpenCoven/../psyche-build'],
      ['origin', 'https://github.com/Open%2Fcoven/psyche-build'],
      ['origin', 'https://github.com/OpenCoven/psyche%5Cbuild'],
      ['origin', 'git@github.com:OpenCoven/psyche-build.git?view=1'],
      ['origin', 'ssh://other@ghe.example.test/OpenCoven/psyche-build.git'],
      ['origin', `ssh://${'git:pw@'}ghe.example.test/OpenCoven/psyche-build.git`],
      ['origin', 'ssh://git@ghe.example.test/OpenCoven/psyche-build.git#frag'],
    ];

    for (const [name, rawUrl] of invalidInputs) {
      expect(normalizeGitHubRemote(name, rawUrl)).toBeNull();
    }
  });

  it('rejects enterprise remotes with invalid explicit ports', () => {
    const invalidPorts = ['0', '022', '65536', '99999', '+22', '-22', '22.0', '22a'];

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
});
