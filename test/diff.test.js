import test from 'node:test';
import assert from 'node:assert/strict';
import { diffProfiles, summarize } from '../src/diff.js';

const base = {
  profile: {
    username: 'natgeo',
    fullName: 'National Geographic',
    biography: 'Inspiring people to care about the planet.',
    followersCount: 280000000,
    followingCount: 1,
    postsCount: 20000,
    externalUrl: null,
    isPrivate: false,
    verified: true,
    profilePicFile: 'avatar-abc.jpg',
  },
  posts: [
    { id: '1', shortcode: 'AAAA', mediaFile: null },
    { id: '2', shortcode: 'BBBB', mediaFile: 'post-def.jpg' },
  ],
};

test('diffProfiles reports no changes when nothing changed', () => {
  const changes = diffProfiles(base, structuredClone(base));
  assert.equal(changes.length, 0);
});

test('diffProfiles detects bio, followers and avatar changes', () => {
  const next = structuredClone(base);
  next.profile.biography = 'New bio';
  next.profile.followersCount = 281000000;
  next.profile.profilePicFile = 'avatar-new.jpg';
  const changes = diffProfiles(base, next);
  const fields = changes.filter((c) => c.type === 'field').map((c) => c.field);
  assert.deepEqual(fields.sort(), ['biography', 'followersCount']);
  assert.ok(changes.some((c) => c.type === 'avatar' && c.from === 'avatar-abc.jpg' && c.to === 'avatar-new.jpg'));
});

test('diffProfiles detects new and removed posts', () => {
  const next = structuredClone(base);
  next.posts = [
    { id: '2', shortcode: 'BBBB' },
    { id: '3', shortcode: 'CCCC', mediaFile: 'post-new.jpg' },
  ];
  const changes = diffProfiles(base, next);
  const added = changes.find((c) => c.type === 'post');
  const removed = changes.find((c) => c.type === 'removed');
  assert.equal(added.postId, '3');
  assert.equal(added.to.mediaFile, 'post-new.jpg');
  assert.equal(removed.postId, '1');
});

test('diffProfiles treats absent previous snapshot as all-new', () => {
  const changes = diffProfiles(null, base);
  assert.ok(changes.some((c) => c.type === 'field'));
  assert.equal(changes.filter((c) => c.type === 'post').length, 2);
});

test('summarize returns flat profile fields', () => {
  const s = summarize(base.profile);
  assert.equal(s.username, 'natgeo');
  assert.equal(s.fullName, 'National Geographic');
  assert.equal(s.profilePicFile, 'avatar-abc.jpg');
  assert.equal(s.biography, base.profile.biography);
});
