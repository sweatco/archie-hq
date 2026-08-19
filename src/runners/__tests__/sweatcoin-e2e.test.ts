import { describe, expect, it } from 'vitest';
import { completeJpegCount, mp4DurationSeconds, validateMjpeg } from '../sweatcoin-e2e.js';

describe('Sweatcoin live canary evidence validation', () => {
  it('counts only complete JPEG frames and validates the multipart boundary', () => {
    const body = Buffer.concat([
      Buffer.from('--mjpegstream\r\n'),
      Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]),
      Buffer.from('\r\n--mjpegstream\r\n'),
      Buffer.from([0xff, 0xd8, 2, 0xff, 0xd9]),
      Buffer.from([0xff, 0xd8, 3]),
    ]);
    expect(completeJpegCount(body)).toBe(2);
    expect(validateMjpeg(body, 'multipart/x-mixed-replace; boundary=--mjpegstream')).toBe(2);
    expect(() => validateMjpeg(body, 'video/mp4')).toThrow(/content type/);
  });

  it('reads version-zero MP4 movie duration', () => {
    const movie = Buffer.alloc(64);
    movie.write('mvhd', 4, 'ascii');
    movie[8] = 0;
    movie.writeUInt32BE(600, 20);
    movie.writeUInt32BE(5798, 24);
    expect(mp4DurationSeconds(movie)).toBeCloseTo(9.663, 3);
  });
});
