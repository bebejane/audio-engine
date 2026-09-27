/**
 * Shared helpers used across the engine: runtime type guards, small DSP
 * utilities, waveform peak extraction and array re-ordering.
 *
 * Nothing here touches the AudioContext; these are pure functions so they can
 * also be imported by the app (the package re-exports this module from its
 * index) and exercised outside the browser.
 */

/** `true` when `arg` is a string primitive or `String` object. */
export const isString = (arg: unknown): boolean => toString.call(arg) === '[object String]';

/** `true` only for plain objects (`{}` / `new Object()`), not arrays or class instances. */
export const isObject = (arg: unknown): boolean => toString.call(arg) === '[object Object]';

/** `true` for callable values (functions, classes, async functions). */
export const isFunction = (arg: unknown): boolean => toString.call(arg) === '[object Function]';

/** `true` for real, finite numbers (rejects `NaN`, `Infinity` and numeric strings). */
export const isNumber = (arg: unknown): boolean =>
	toString.call(arg) === '[object Number]' && (arg as number) === +arg;

/** `true` for arrays (including cross-realm arrays). */
export const isArray = (arg: unknown): boolean => toString.call(arg) === '[object Array]';

/** `true` when `arg` is a number within the inclusive `[min, max]` range. */
export const isInRange = (arg: unknown, min: unknown, max: unknown): boolean => {
	if (!isNumber(arg) || !isNumber(min) || !isNumber(max)) return false;

	return (arg as number) >= (min as number) && (arg as number) <= (max as number);
};

/** `true` for boolean primitives. */
export const isBool = (arg: unknown): boolean => typeof arg === 'boolean';

/** `true` when `audioNode` is an `OscillatorNode` (via its `toString` tag). */
export const isOscillator = (audioNode: { toString(): string } | null | undefined): boolean =>
	!!audioNode && audioNode.toString() === '[object OscillatorNode]';

/** `true` when `audioNode` is an `AudioBufferSourceNode` (via its `toString` tag). */
export const isAudioBufferSourceNode = (
	audioNode: { toString(): string } | null | undefined,
): boolean => !!audioNode && audioNode.toString() === '[object AudioBufferSourceNode]';

/**
 * Equal-power dry level for a 0–1 wet/dry `mix` control.
 *
 * At `mix = 0` the dry signal is full (1), at `mix = 0.5` it is 1, and from
 * there it tapers linearly to 0 at `mix = 1`. Returns 0 for an out-of-range or
 * non-numeric mix.
 */
export const getDryLevel = (mix: number): number => {
	if (!isNumber(mix) || mix > 1 || mix < 0) return 0;
	if (mix <= 0.5) return 1;
	return 1 - (mix - 0.5) * 2;
};

/**
 * Equal-power wet level for a 0–1 wet/dry `mix` control — the mirror of
 * {@link getDryLevel}: 0 at `mix = 0`, rising to 1 at `mix = 0.5` and staying
 * there. Returns 0 for an out-of-range or non-numeric mix.
 */
export const getWetLevel = (mix: number): number => {
	if (!isNumber(mix) || mix > 1 || mix < 0) return 0;
	if (mix >= 0.5) return 1;
	return 1 - (0.5 - mix) * 2;
};

/**
 * Clamp `value` into `[min, max]` (inclusive). If `min > max` the arguments are
 * treated as reversed, so the result still lies between the two bounds.
 */
export const clamp = (value: number, min: number, max: number): number =>
	min < max
		? value < min
			? min
			: value > max
				? max
				: value
		: value < max
			? max
			: value > min
				? min
				: value;

/**
 * Map an audio filename to its MIME type by extension (mp3/mp4/m4a/wav/ogg/
 * aif/webm). Returns the original falsy input unchanged, or `null` for an
 * unknown extension.
 */
export const fileToMimeType = (filename?: string) => {
	if (!filename) return filename ?? null;
	const file = filename.toLowerCase();
	if (file.endsWith('.mp3')) return 'audio/mpeg';
	if (file.endsWith('.mp4') || file.endsWith('.m4a')) return 'audio/mp4';
	if (file.endsWith('.wav')) return 'audio/wav';
	if (file.endsWith('.ogg')) return 'audio/ogg';
	if (file.endsWith('.aif')) return 'audio/aiff';
	if (file.endsWith('.webm')) return 'audio/webm';
	return null;
};

// ---------------------------------------------------------------- DSP utils --

/**
 * Find the zero-crossing cut point nearest to `from`, scanning in `dir`
 * direction (1 = forward, -1 = backward) for up to `maxLook` samples.
 *
 * A crossing is an exact 0 sample, or a sign change between two consecutive
 * samples (the zero lies between them). Returns the index of the crossing
 * member CLOSEST to zero, so slicing there starts/stops on a stationary,
 * near-zero point instead of mid-cycle (no click). Returns -1 when no
 * crossing is found within the window.
 *
 * Callers treat the return value as a "retained" index:
 *   - left edge (start):  start = zc      (first sample kept = data[zc])
 *   - right edge (end):   end   = zc + 1  (last  sample kept = data[zc])
 *
 * `from` must be within [0, data.length - 1].
 *
 * @param data - mono sample data to scan.
 * @param from - index to start scanning from.
 * @param dir - scan direction: `1` forward, `-1` backward.
 * @param maxLook - maximum number of samples to search.
 * @returns the retained crossing index, or `-1` when none was found.
 */
export const findZeroCrossing = (
	data: Float32Array,
	from: number,
	dir = 1,
	maxLook = 256,
): number => {
	const n = data.length;
	if (n < 2 || from < 0 || from > n - 1) return -1;
	const limit = Math.min(maxLook, n);
	for (let i = 0; i < limit; i++) {
		const idx = from + i * dir;
		if (idx < 0 || idx > n - 2) break;
		const a = data[idx];
		const b = data[idx + 1];
		// exact zero sample: the perfect stationary point to cut at
		if (a === 0) return idx;
		if (b === 0) return idx + 1;
		// sign change between idx and idx+1: pick the member closest to zero
		if ((a > 0 && b <= 0) || (a < 0 && b >= 0)) return Math.abs(a) <= Math.abs(b) ? idx : idx + 1;
	}
	return -1;
};

/**
 * Reverse the PCM of every channel of `buffer` in place.
 *
 * @param buffer - the AudioBuffer to reverse.
 * @returns the same buffer instance, reversed.
 */
export const reverse = (buffer: AudioBuffer): AudioBuffer => {
	for (let i = 0, c = buffer.numberOfChannels; i < c; ++i) buffer.getChannelData(i).reverse();
	return buffer;
};

/**
 * Peak-normalize each channel of `buffer` so the loudest sample reaches full
 * scale, clamping the result to `[-1, 1]`.
 *
 * The optional `start`/`end` bounds accept negative and `-Infinity` indices
 * (normalized with `nidx`) but the current implementation ignores them when
 * computing the peak; they are kept for API compatibility.
 *
 * @param buffer - per-channel Float32 sample arrays.
 * @param start - optional start index (negative allowed).
 * @param end - optional end index (negative allowed).
 * @returns new per-channel Float32 arrays scaled to peak amplitude.
 */
export const normalize = (buffer: Float32Array[], start?: number, end?: number): Float32Array[] => {
	const isNeg = (number: number): boolean => {
		return number === 0 && 1 / number === -Infinity;
	};

	const nidx = (idx: number | null | undefined, length: number): number =>
		idx == null
			? 0
			: isNeg(idx)
				? length
				: idx <= -length
					? 0
					: idx < 0
						? length + (idx % length)
						: Math.min(length, idx);

	start = start == null ? 0 : nidx(start, buffer.length);
	end = end == null ? buffer.length : nidx(end, buffer.length);

	// for every channel bring it to max-min amplitude range
	const normalized: Float32Array[] = [];
	let max = 0;

	for (let c = 0; c < buffer.length; c++) {
		const data = buffer[c];

		for (let i = 0; i < data.length; i++) {
			max = Math.max(Math.abs(data[i]), max);
		}
		normalized.push(new Float32Array(buffer[c].length));
	}

	const amp = Math.max(1 / max, 1);

	for (let c = 0; c < buffer.length; c++) {
		const data = buffer[c];
		for (let i = 0; i < data.length; i++) normalized[c][i] = clamp(data[i] * amp, -1, 1);
	}
	console.log('NORMALIZED', amp, normalized.length);
	return normalized;
};

/**
 * Slice a half-open `[start, end)` sample range out of per-channel data.
 *
 * Returns a new array with one or two channels. `end` is clamped to the last
 * sample. NOTE: the right (second) channel is currently copied from `buffer[0]`
 * like the left — this is the historical behaviour and is retained deliberately.
 *
 * @param buffer - one or two channel Float32 arrays.
 * @param start - first sample index (inclusive).
 * @param end - last sample index (exclusive).
 */
export const slice = (buffer: Float32Array[], start: number, end: number): Float32Array[] => {
	if (end > buffer[0].length) end = buffer[0].length - 1;

	const rightChunk = new Float32Array(end - start);
	const leftChunk = new Float32Array(end - start);

	for (let i = start, x = 0; x < leftChunk.length; x++, i++) leftChunk[x] = buffer[0][i];

	if (buffer.length === 2) {
		for (let i = start, x = 0; x < rightChunk.length; x++, i++) rightChunk[x] = buffer[0][i];
	}

	if (buffer.length === 2) return [leftChunk, rightChunk];
	else return [leftChunk];
};

/**
 * Apply a fade envelope to the start of every channel of `buffer`.
 *
 * Currently a no-op: it returns the buffer immediately (the implementation
 * below is disabled/experimental and forces `ms = 1000`).
 *
 * @param buffer - per-channel Float32 sample arrays.
 * @param ms - fade length in milliseconds (ignored).
 * @param sampleRate - sample rate (ignored).
 * @returns the input buffer unchanged.
 */
export const fade = (buffer: Float32Array[], ms: number, sampleRate = 44100): Float32Array[] => {
	return buffer;
	ms = 1000;
	const isNeg = (number: number): boolean => {
		return number === 0 && 1 / number === -Infinity;
	};

	const nidx = (idx: number | null | undefined, length: number): number =>
		idx == null
			? 0
			: isNeg(idx)
				? length
				: idx <= -length
					? 0
					: idx < 0
						? length + (idx % length)
						: Math.min(length, idx);

	for (let c = 0; c < buffer.length; c++) {
		const data = buffer[c];
		const samples = ms * (44100 / 1000);
		const level = data[samples];
		const amp = level / samples;
		console.log('fade', samples, level, amp);
		const fadeFrameCount = samples;
		const ascending = false;

		for (let i = 0; i < fadeFrameCount; i++) {
			const currentFrameFadePercentage = (i - 0) / fadeFrameCount;
			data[i] = ascending
				? data[i] * currentFrameFadePercentage
				: data[i] * (1 - currentFrameFadePercentage);
			if (i < 100) console.log(data[i]);
		}
	}
	return buffer;
};

/** Options for {@link trim}. */
export interface TrimOptions {
	sampleRate?: number;
	trimLeft?: boolean;
	trimRight?: boolean;
	level?: number;
}

/**
 * Trim leading (and optionally trailing) silence from a recording, snapping
 * both cut points to a nearby zero crossing so the result starts/stops on a
 * stationary sample (no click).
 *
 * The search window for a crossing is ~8 ms: wide enough to find one for
 * low-pitched content but short enough that snapping never audibly shifts the
 * attack or eats the tail. When no crossing is found the cut lands one sample
 * inside the detected content, which is still click-free.
 *
 * @param buffer - per-channel Float32 sample arrays (channel 0 drives detection).
 * @param opt - trim options; defaults to left-trim at level 0.05.
 * @returns the trimmed per-channel arrays (see {@link slice}).
 */
export const trim = (
	buffer: Float32Array[],
	opt: TrimOptions = { sampleRate: 44100, trimLeft: true, trimRight: false, level: 0.05 },
): Float32Array[] => {
	const level = opt.level == null ? 0 : Math.abs(opt.level);
	const sampleRate = opt.sampleRate || 44100;
	// how far to hunt for a zero crossing: ~8ms. Big enough to catch a crossing
	// even for low-pitched content (a 62Hz tone's nearest crossing is ~8ms away),
	// small enough that snapping never audibly shifts the attack or eats the tail.
	const maxLook = Math.max(64, Math.round(sampleRate * 0.008));

	let start = 0;
	let end = buffer[0].length;

	if (opt.trimLeft) {
		const data = buffer[0];
		for (let i = 0; i < data.length; i++) {
			if (Math.abs(data[i]) > level) {
				start = i;
				break;
			}
		}
		// snap the cut point to the nearest zero crossing so the sample starts
		// on a stationary point instead of a mid-cycle value (click)
		if (start > 0) {
			const zc = findZeroCrossing(data, start - 1, -1, maxLook);
			if (zc >= 0) start = zc;
			else start = start - 1; // everything before start is <= level: cutting one sample early is click-free
		} else {
			// recording began mid-cycle with no pre-roll silence: snap forward
			// to the next crossing (removes at most ~maxLook of near-zero onset),
			// but only take it if the crossing member is actually quieter than
			// the current first sample (keeps the attack fully intact)
			const zc = findZeroCrossing(data, 0, 1, maxLook);
			if (zc >= 0 && Math.abs(data[zc]) < Math.abs(data[0])) start = zc;
		}
	}
	if (opt.trimRight) {
		const data = buffer[0];
		for (let i = data.length - 1; i >= 0; i--) {
			if (Math.abs(data[i]) > level) {
				end = i + 1;
				break;
			}
		}
		// snap the cut point forward to the next zero crossing in the
		// below-level tail so the sample also ends on a stationary point
		// (avoids a click at loop wrap); keep the crossing only if its member
		// is quieter than the current last sample
		const zc = findZeroCrossing(data, end, 1, maxLook);
		if (zc >= 0 && end > 0 && Math.abs(data[zc]) < Math.abs(data[end - 1])) end = zc + 1;
	}

	// the two snaps may step toward each other; keep a minimum length so
	// slice() never gets a negative/zero range
	if (end <= start) end = Math.min(buffer[0].length, start + 1);

	console.log(
		'trim',
		'left',
		opt.trimLeft,
		'right',
		opt.trimRight,
		start,
		end,
		'buffer',
		buffer[0].length,
	);
	return slice(buffer, start, end);
};

// ------------------------------------------------------------ peaks --
// Ported from the MIT-licensed "webaudio-peaks" package (© Naomi Aro,
// github.com/naomiaro/webaudio-peaks) so the engine carries no runtime
// dependency on it. `extractPeaks` returns per-channel interleaved [min,max]
// peak arrays quantized to 8/16/32-bit signed integers.

/** Per-channel interleaved `[min, max]` peak data produced by {@link extractPeaks}. */
export interface Peaks {
	/** Number of `[min, max]` pairs per channel. */
	length: number;
	/** One typed array per channel, interleaved min/max. */
	data: Array<Int8Array | Int16Array | Int32Array>;
	/** Quantization depth (8, 16 or 32). */
	bits: number;
}

/** Return the `{ min, max }` extrema of `array` (Infinity pair when empty). */
const findMinMax = (array: Float32Array): { min: number; max: number } => {
	let min = Infinity;
	let max = -Infinity;
	for (let i = 0; i < array.length; i++) {
		const curr = array[i];
		if (min > curr) min = curr;
		if (max < curr) max = curr;
	}
	return { min, max };
};

/** Quantize a normalized sample `n` to a signed `bits`-wide integer. */
const convert = (n: number, bits: number): number => {
	const max = Math.pow(2, bits - 1);
	const v = n < 0 ? n * max : n * max - 1;
	return Math.max(-max, Math.min(max - 1, v));
};

/** Allocate the typed array matching `bits` (8/16/32; 32 is the fallback). */
const makePeakArray = (bits: number, length: number): Int8Array | Int16Array | Int32Array => {
	if (bits === 8) return new Int8Array(length);
	if (bits === 16) return new Int16Array(length);
	return new Int32Array(length);
};

/** Reduce one channel to interleaved `[min, max]` peaks, `samplesPerPixel` apart. */
const extractChannelPeaks = (
	channel: Float32Array,
	samplesPerPixel: number,
	bits: number,
): Int8Array | Int16Array | Int32Array => {
	const chanLength = channel.length;
	const numPeaks = Math.ceil(chanLength / samplesPerPixel);
	const peaks = makePeakArray(bits, numPeaks * 2);
	for (let i = 0; i < numPeaks; i++) {
		const start = i * samplesPerPixel;
		const end = (i + 1) * samplesPerPixel > chanLength ? chanLength : (i + 1) * samplesPerPixel;
		const extrema = findMinMax(channel.subarray(start, end));
		peaks[i * 2] = convert(extrema.min, bits);
		peaks[i * 2 + 1] = convert(extrema.max, bits);
	}
	return peaks;
};

/** Average multiple channel peak arrays into a single mono peak array. */
const makeMono = (
	channelPeaks: Array<Int8Array | Int16Array | Int32Array>,
	bits: number,
): Array<Int8Array | Int16Array | Int32Array> => {
	const numChan = channelPeaks.length;
	const weight = 1 / numChan;
	const numPeaks = channelPeaks[0].length / 2;
	const peaks = makePeakArray(bits, numPeaks * 2);
	for (let i = 0; i < numPeaks; i++) {
		let min = 0;
		let max = 0;
		for (let c = 0; c < numChan; c++) {
			min += weight * channelPeaks[c][i * 2];
			max += weight * channelPeaks[c][i * 2 + 1];
		}
		peaks[i * 2] = min;
		peaks[i * 2 + 1] = max;
	}
	return [peaks];
};

/**
 * Extract interleaved [min, max] peaks from an AudioBuffer (or a raw
 * Float32Array channel): `samplesPerPixel` audio frames per peak, quantized to
 * `bits` (8/16/32). `isMono` averages the channels together (default true).
 *
 * @param source - an AudioBuffer or a single Float32 channel.
 * @param samplesPerPixel - frames summarized per peak (default 10000).
 * @param isMono - average all channels into one peak array (default true).
 * @param cueIn - first sample frame to include.
 * @param cueOut - last sample frame to include.
 * @param bits - quantization depth: 8, 16 or 32 (default 8).
 * @throws when `bits` is not 8, 16 or 32.
 */
export const extractPeaks = (
	source: AudioBuffer | Float32Array,
	samplesPerPixel = 10000,
	isMono = true,
	cueIn?: number,
	cueOut?: number,
	bits = 8,
): Peaks => {
	if ([8, 16, 32].indexOf(bits) < 0) throw new Error('Invalid number of bits specified for peaks.');

	let peaks: Array<Int8Array | Int16Array | Int32Array> = [];
	if (typeof (source as Float32Array).subarray === 'undefined') {
		const buffer = source as AudioBuffer;
		for (let c = 0; c < buffer.numberOfChannels; c++) {
			const channel = buffer.getChannelData(c);
			peaks.push(
				extractChannelPeaks(
					channel.subarray(cueIn || 0, cueOut || channel.length),
					samplesPerPixel,
					bits,
				),
			);
		}
	} else {
		const channel = source as Float32Array;
		peaks.push(
			extractChannelPeaks(
				channel.subarray(cueIn || 0, cueOut || channel.length),
				samplesPerPixel,
				bits,
			),
		);
	}

	if (isMono && peaks.length > 1) peaks = makeMono(peaks, bits);

	return { length: peaks[0].length / 2, data: peaks, bits };
};

// ------------------------------------------------------- array-move --
// Ported from the MIT-licensed "array-move" package (© Sindre Sorhus,
// github.com/sindresorhus/array-move).

/**
 * Move the item at `fromIndex` to `toIndex` within `array`, mutating it in
 * place. Negative indices count from the end; out-of-range sources are ignored.
 *
 * @param array - the array to reorder.
 * @param fromIndex - index of the item to move.
 * @param toIndex - destination index.
 */
export const arrayMoveMutable = <T>(array: T[], fromIndex: number, toIndex: number): void => {
	const startIndex = fromIndex < 0 ? array.length + fromIndex : fromIndex;

	if (startIndex >= 0 && startIndex < array.length) {
		const endIndex = toIndex < 0 ? array.length + toIndex : toIndex;

		const [item] = array.splice(fromIndex, 1);
		array.splice(endIndex, 0, item);
	}
};

/**
 * Immutable variant of {@link arrayMoveMutable}: returns a new array with the
 * item moved, leaving the input untouched.
 *
 * @param array - the source array (not mutated).
 * @param fromIndex - index of the item to move.
 * @param toIndex - destination index.
 */
export const arrayMoveImmutable = <T>(
	array: readonly T[],
	fromIndex: number,
	toIndex: number,
): T[] => {
	const moved = [...array];
	arrayMoveMutable(moved, fromIndex, toIndex);
	return moved;
};
