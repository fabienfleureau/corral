// Colleagues' PRs: the page lists open PRs from the repos the human can push
// to. Turning a configured repo into a platform scope is the seam that decides
// which repos those are, so it is tested without touching the platforms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteFromUrl } from '../pulls.ts';

test('a git remote becomes the repo it points at', () => {
  assert.deepEqual(remoteFromUrl('git@github.com:Qovery/service-catalog.git'), { host: 'github', path: 'Qovery/service-catalog' });
  assert.deepEqual(remoteFromUrl('https://github.com/fabienfleureau/corral.git'), { host: 'github', path: 'fabienfleureau/corral' });
  assert.deepEqual(remoteFromUrl('https://github.com/fabienfleureau/corral'), { host: 'github', path: 'fabienfleureau/corral' });
  assert.deepEqual(remoteFromUrl('ssh://git@gitlab.com/qovery/backend/homer.git'), { host: 'gitlab', path: 'qovery/backend/homer' });
  // GitLab groups nest; GitHub paths never do.
  assert.deepEqual(remoteFromUrl('git@gitlab.com:qovery/backend/homer.git\n'), { host: 'gitlab', path: 'qovery/backend/homer' });
  assert.equal(remoteFromUrl('git@github.com:kubernetes/kubernetes/staging.git'), null);
});

test('remotes that are not a platform repo are ignored', () => {
  assert.equal(remoteFromUrl(''), null);
  assert.equal(remoteFromUrl('   '), null);
  assert.equal(remoteFromUrl('/Users/ffleureau/workspace/local-only'), null);
  assert.equal(remoteFromUrl('https://git.example.com/team/project.git'), null);
  assert.equal(remoteFromUrl('git@github.com:Qovery.git'), null);
});
