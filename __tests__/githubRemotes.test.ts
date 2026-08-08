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
  it('normalizes supported GitHub remote URL formats to canonical repository identities', () => {
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

    expect(
      normalizeGitHubRemote('enterprise-ssh', 'ssh://git@GHE.Example.Test:2222/OpenCoven/psyche-build.git'),
    ).toEqual({
      name: 'enterprise-ssh',
      rawUrl: 'ssh://git@GHE.Example.Test:2222/OpenCoven/psyche-build.git',
      repository: {
        host: 'ghe.example.test',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://ghe.example.test/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote('enterprise-ssh-22', 'ssh://git@ghe.example.test:22/OpenCoven/psyche-build.git')).toEqual({
      name: 'enterprise-ssh-22',
      rawUrl: 'ssh://git@ghe.example.test:22/OpenCoven/psyche-build.git',
      repository: {
        host: 'ghe.example.test',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://ghe.example.test/OpenCoven/psyche-build',
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

    expect(normalizeGitHubRemote('encoded-path', 'https://github.com/Open%43oven/psyche%2Dbuild%2Egit')).toEqual({
      name: 'encoded-path',
      rawUrl: 'https://github.com/Open%43oven/psyche%2Dbuild%2Egit',
      repository: {
        host: 'github.com',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://github.com/OpenCoven/psyche-build',
      },
    });
  });

  it('canonicalizes IDN authorities and accepts bracketed IPv6 URL forms', () => {
    const unicodeIdn = normalizeGitHubRemote('unicode-idn', 'https://BÜCHER.example/OpenCoven/psyche-build.git');
    const punycodeIdn = normalizeGitHubRemote('punycode-idn', 'https://xn--bcher-kva.example/OpenCoven/psyche-build.git');

    expect(unicodeIdn?.repository).toEqual({
      host: 'xn--bcher-kva.example',
      owner: 'OpenCoven',
      name: 'psyche-build',
      url: 'https://xn--bcher-kva.example/OpenCoven/psyche-build',
    });
    expect(punycodeIdn?.repository).toEqual(unicodeIdn?.repository);

    expect(normalizeGitHubRemote('ipv6-https', 'https://[2001:db8::1]:8443/OpenCoven/psyche-build.git')).toEqual({
      name: 'ipv6-https',
      rawUrl: 'https://[2001:db8::1]:8443/OpenCoven/psyche-build.git',
      repository: {
        host: '[2001:db8::1]:8443',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://[2001:db8::1]:8443/OpenCoven/psyche-build',
      },
    });

    expect(normalizeGitHubRemote('ipv6-ssh', 'ssh://git@[2001:db8::1]:2222/OpenCoven/psyche-build.git')).toEqual({
      name: 'ipv6-ssh',
      rawUrl: 'ssh://git@[2001:db8::1]:2222/OpenCoven/psyche-build.git',
      repository: {
        host: '[2001:db8::1]',
        owner: 'OpenCoven',
        name: 'psyche-build',
        url: 'https://[2001:db8::1]/OpenCoven/psyche-build',
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
      ['origin', 'https://ghe%2Eexample.test/OpenCoven/psyche-build.git'],
      ['origin', 'https://ghe.example.test\\OpenCoven/psyche-build.git'],
      ['origin', 'https://ghe.example.test/Open%2Fcoven/psyche-build.git'],
      ['origin', 'https://ghe.example.test/OpenCoven/psyche%2Fbuild.git'],
      ['origin', 'https://ghe.example.test/OpenCoven/psyche%5Cbuild.git'],
      ['origin', 'https://ghe.example.test/OpenCoven/psyche-build%2Egit%2Egit'],
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
      ['origin', 'git@ghe%2Eexample.test:OpenCoven/psyche-build.git'],
      ['origin', 'git@github.com:OpenCoven/psyche-build.git?view=1'],
      ['origin', 'ssh://git@ghe.example.test/OpenCoven'],
      ['origin', 'ssh://git@github.com:22/OpenCoven/psyche-build.git'],
      ['origin', 'ssh://git@github.com:2222/OpenCoven/psyche-build.git'],
      ['origin', 'ssh://git@ghe%2Eexample.test/OpenCoven/psyche-build.git'],
      ['origin', 'ssh://git@ghe.example.test\\OpenCoven/psyche-build.git'],
      ['origin', 'ssh://git@ghe.example.test/Open Coven/psyche-build.git'],
      ['origin', 'ssh://git@ghe.example.test/Open%20Coven/psyche-build.git'],
      ['origin', 'ssh://git@ghe.example.test/OpenCoven/psyche build.git'],
      ['origin', 'ssh://git@ghe.example.test/OpenCoven/psyche%20build.git'],
      ['origin', 'https://github.com/OpenCoven'],
      ['origin', 'https://github.com/OpenCoven/psyche-build/issues'],
      ['origin', 'https://github.com/OpenCoven/.git'],
      ['origin', 'https://github.com/OpenCoven/psyche-build.git.git'],
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
