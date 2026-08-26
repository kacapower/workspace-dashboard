import test from 'node:test';
import assert from 'node:assert/strict';
import { pickStoryMedia } from '../src/stories.js';

test('pickStoryMedia prefers the highest-res image candidate', () => {
  const url = pickStoryMedia({
    media_type: 1,
    image_versions2: {
      candidates: [
        { url: 'https://cdn/high-res.jpg', width: 1080 },
        { url: 'https://cdn/low-res.jpg', width: 320 },
      ],
    },
  });
  assert.equal(url, 'https://cdn/high-res.jpg');
});

test('pickStoryMedia prefers the video for video stories', () => {
  const url = pickStoryMedia({
    media_type: 2,
    image_versions2: { candidates: [{ url: 'https://cdn/poster.jpg' }] },
    video_versions: [{ url: 'https://cdn/full-video.mp4' }],
  });
  assert.equal(url, 'https://cdn/full-video.mp4');
});

test('pickStoryMedia falls back to common fields when structured data is missing', () => {
  assert.equal(pickStoryMedia({ mediaUrl: 'https://cdn/story.jpg' }), 'https://cdn/story.jpg');
  assert.equal(pickStoryMedia({ displayUrl: 'https://cdn/x.jpg' }), 'https://cdn/x.jpg');
  assert.equal(pickStoryMedia({}), null);
});