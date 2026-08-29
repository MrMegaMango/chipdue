import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const BLUE = [61, 90, 254];
const WHITE = [255, 253, 249];
const GOLD = [229, 184, 85];
const VIEWBOX_SIZE = 64;
const SAMPLE_GRID = 4;

const crcTable = Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	return crc >>> 0;
});

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
	const name = Buffer.from(type, 'ascii');
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
	return Buffer.concat([length, name, data, checksum]);
}

function distanceToSegment(x, y, startX, startY, endX, endY) {
	const deltaX = endX - startX;
	const deltaY = endY - startY;
	const lengthSquared = deltaX * deltaX + deltaY * deltaY;
	const projection = Math.max(
		0,
		Math.min(1, ((x - startX) * deltaX + (y - startY) * deltaY) / lengthSquared)
	);
	return Math.hypot(x - (startX + projection * deltaX), y - (startY + projection * deltaY));
}

// These shapes mirror static/app-icon-source.svg. The square background is intentional:
// each platform applies its own rounded Home Screen mask.
function colorAt(x, y) {
	const dot = Math.hypot(x - 47, y - 32) <= 4.5;
	if (dot) return GOLD;

	const angle = Math.abs(Math.atan2(y - 32, x - 28.5));
	const cMark = Math.abs(Math.hypot(x - 28.5, y - 32) - 18.5) <= 2.75 && angle >= 0.73;
	const minuteHand = distanceToSegment(x, y, 31.75, 21.75, 31.75, 32.25) <= 2.125;
	const hourHand = distanceToSegment(x, y, 31.75, 32.25, 39.25, 36.5) <= 2.125;
	return cMark || minuteHand || hourHand ? WHITE : BLUE;
}

function renderPng(size) {
	const stride = size * 3 + 1;
	const pixels = Buffer.alloc(stride * size);
	for (let pixelY = 0; pixelY < size; pixelY += 1) {
		const rowOffset = pixelY * stride;
		pixels[rowOffset] = 0;
		for (let pixelX = 0; pixelX < size; pixelX += 1) {
			const totals = [0, 0, 0];
			for (let sampleY = 0; sampleY < SAMPLE_GRID; sampleY += 1) {
				for (let sampleX = 0; sampleX < SAMPLE_GRID; sampleX += 1) {
					const x = ((pixelX + (sampleX + 0.5) / SAMPLE_GRID) * VIEWBOX_SIZE) / size;
					const y = ((pixelY + (sampleY + 0.5) / SAMPLE_GRID) * VIEWBOX_SIZE) / size;
					const color = colorAt(x, y);
					for (let channel = 0; channel < 3; channel += 1) totals[channel] += color[channel];
				}
			}
			const offset = rowOffset + 1 + pixelX * 3;
			for (let channel = 0; channel < 3; channel += 1) {
				pixels[offset + channel] = Math.round(totals[channel] / SAMPLE_GRID ** 2);
			}
		}
	}

	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from('89504e470d0a1a0a', 'hex'),
		chunk('IHDR', header),
		chunk('sRGB', Buffer.from([0])),
		chunk('IDAT', deflateSync(pixels, { level: 9 })),
		chunk('IEND')
	]);
}

export function generateAppIcons(root = resolve('.')) {
	for (const [filename, size] of [
		['apple-touch-icon.png', 180],
		['icon-192.png', 192],
		['icon-512.png', 512]
	]) {
		writeFileSync(resolve(root, 'static', filename), renderPng(size));
	}
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	generateAppIcons();
}
