export interface WavOptions {
	sampleRate?: number;
	numChannels?: number;
}

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
	function floatTo16BitPCM(output: DataView, offset: number, input: Float32Array): void {
		for (let i = 0; i < input.length; i++, offset += 2) {
			const s = Math.max(-1, Math.min(1, input[i]));
			output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
		}
	}

	function writeString(view: DataView, offset: number, string: string): void {
		for (let i = 0; i < string.length; i++) {
			view.setUint8(offset + i, string.charCodeAt(i));
		}
	}

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
