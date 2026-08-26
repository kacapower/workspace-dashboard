const COMPARED_FIELDS = [
  'fullName',
  'biography',
  'followersCount',
  'followingCount',
  'postsCount',
  'externalUrl',
  'isPrivate',
];

export function diffProfiles(prev, next) {
  const changes = [];
  const p = prev ? prev.profile : {};
  const n = next.profile;

  for (const field of COMPARED_FIELDS) {
    const before = p[field];
    const after = n[field];
    if (String(before ?? '') !== String(after ?? '')) {
      changes.push({ type: 'field', field, from: before ?? null, to: after ?? null });
    }
  }

  if (n.profilePicFile && (!p.profilePicFile || n.profilePicFile !== p.profilePicFile)) {
    changes.push({ type: 'avatar', field: 'profilePic', from: p.profilePicFile || null, to: n.profilePicFile });
  }

  const prevIds = new Set((prev ? prev.posts : []).map((post) => post.id));
  const nextIds = new Set(next.posts.map((post) => post.id));

  for (const post of next.posts) {
    if (!prevIds.has(post.id)) {
      changes.push({
        type: 'post',
        field: 'newPost',
        postId: post.id,
        to: {
          shortcode: post.shortcode,
          timestamp: post.timestamp,
          caption: post.caption,
          likesCount: post.likesCount,
          commentsCount: post.commentsCount,
          mediaFile: post.mediaFile || null,
        },
      });
    }
  }

  for (const post of prev ? prev.posts : []) {
    if (!nextIds.has(post.id)) {
      changes.push({ type: 'removed', field: 'removedPost', postId: post.id, from: post.shortcode });
    }
  }

  return changes;
}

export function summarize(profile) {
  return {
    username: profile.username,
    fullName: profile.fullName,
    biography: profile.biography,
    followersCount: profile.followersCount,
    followingCount: profile.followingCount,
    postsCount: profile.postsCount,
    externalUrl: profile.externalUrl,
    isPrivate: profile.isPrivate,
    verified: profile.verified,
    profilePicFile: profile.profilePicFile,
  };
}
