/** Options for the WAV encoder. */
export interface WavOptions {
	/** Sample rate written into the fmt chunk (default 44100). */
	sampleRate?: number;
	/** 1 for mono, 2 for interleaved stereo (default 2). */
	numChannels?: number;
}

/**
 * Encode per-channel Float32 PCM as a 16-bit PCM little-endian WAV Blob.
 *
 * Runs on the main thread but is invoked from the encoder worker
 * (encoders/worker.ts) for both recording and export. Resolves with the Blob;
 * rejects if the RIFF header or sample conversion throws.
 *
 * @param buffer - one or two channel sample arrays (channel 0 drives mono).
 * @param opt - sample rate and channel count.
 */
const wavEncoder = (
	buffer: Float32Array[],
	opt: WavOptions = { sampleRate: 44100, numChannels: 2 },
): Promise<Blob> => {
	return new Promise((resolve, reject) => {
		try {
			const blob = encodeWAV(buffer, opt)
			resolve(blob)
		} catch (err) {
			reject(err)
		}
	})

	/** Interleave left/right channels into one L,R,L,R Float32 stream. */
	function interleave(inputL: Float32Array, inputR: Float32Array): Float32Array {
		const length = inputL.length + inputR.length;
		const result = new Float32Array(length);

		let index = 0,
			inputIndex = 0;

		while (index < length) {
			result[index++] = inputL[inputIndex];
			result[index++] = inputR[inputIndex];
			inputIndex++;
		}
		return result;
	}
	/** Write Float32 samples as clamped 16-bit signed PCM at `offset`. */
	function floatTo16BitPCM(output: DataView, offset: number, input: Float32Array): void {
		for (let i = 0; i < input.length; i++, offset += 2) {
			const s = Math.max(-1, Math.min(1, input[i]));
			output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
		}
	}

	/** Write an ASCII string into the DataView at `offset` (WAV chunk tags). */
	function writeString(view: DataView, offset: number, string: string): void {
		for (let i = 0; i < string.length; i++) {
			view.setUint8(offset + i, string.charCodeAt(i));
		}
	}

	/** Build the 44-byte RIFF/fmt header + PCM body for `samples`. */
	function encodeWAV(
		samples: Float32Array[],
		opt: WavOptions = { sampleRate: 44100, numChannels: 2 },
	): Blob {
		console.log('ENCODE WAV', opt.sampleRate, opt.numChannels)
		const pcm: Float32Array =
			opt.numChannels === 2 ? interleave(samples[0], samples[1]) : samples[0];

		const buffer = new ArrayBuffer(44 + pcm.length * 2);
		const view = new DataView(buffer);

		/* RIFF identifier */
		writeString(view, 0, 'RIFF');

		/* RIFF chunk length */
		view.setUint32(4, 36 + pcm.length * 2, true);
		/* RIFF type */
		writeString(view, 8, 'WAVE');
		/* format chunk identifier */
		writeString(view, 12, 'fmt ');
		/* format chunk length */
		view.setUint32(16, 16, true);
		/* sample format (raw) */
		view.setUint16(20, 1, true);
		/* channel count */
		view.setUint16(22, opt.numChannels as number, true);
		/* sample rate */
		view.setUint32(24, opt.sampleRate as number, true);
		/* byte rate (sample rate * block align) */
		view.setUint32(28, (opt.sampleRate as number) * 4, true);
		/* block align (channel count * bytes per sample) */
		view.setUint16(32, (opt.numChannels as number) * 2, true);
		/* bits per sample */
		view.setUint16(34, 16, true);
		/* data chunk identifier */
		writeString(view, 36, 'data');
		/* data chunk length */
		view.setUint32(40, pcm.length * 2, true);

		floatTo16BitPCM(view, 44, pcm);

		return new Blob([view], { type: 'audio/wav' });
	}
};

export default wavEncoder
