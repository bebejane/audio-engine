/**
 * ModelManager — owns all model and preset I/O for the audio engine.
 *
 * Loads/saves/downloads .zip models (fetch, JSZip, sound population),
 * and keeps the per-model preset list (snapshots of every sound's settings)
 * that is persisted inside index.json. The React layer only renders the grid
 * and calls these methods; it no longer touches JSZip/sound internals.
 */
import JSZip from 'jszip';
import type AudioEngine from './audioengine';
import type Sound from './sound';
import { fileToMimeType } from './utils';
import type {
	EffectSnapshot,
	Model,
	ModelMeta,
	Preset,
	PresetSlot,
	PresetSound,
	SoundSettings,
} from './types';

const MODEL_VERSION = 2;
/** One preset slot per number key (1-9, then 0). */
const PRESET_SLOTS = 10;

/** A live sound as the engine stores it (engine.sounds / engine.get()). */
interface SoundItem {
	id: string;
	url?: string | null;
	filename?: string | null;
	sound: Sound;
}

/**
 * Owns model and preset I/O for the engine: fetch/unzip/populate models,
 * serialize the current engine state to a .zip, and read/write the
 * slot-addressed preset list persisted inside index.json.
 *
 * Constructed by `AudioEngine` (exposed as `engine.modelManager`); the engine's
 * `models`/`presets`/`loadModel`/… methods are thin facades over this class.
 */
export default class ModelManager {
	engine: AudioEngine;
	/** Entries from /models/index.json (plus in-session "new" models). */
	models: ModelMeta[] = [];
	/** The currently loaded model (or null before the first load). */
	model: Model | null = null;
	/** Saved settings snapshots, one slot per number key (null = empty). */
	presets: PresetSlot[] = [];
	/**
	 * The slot currently being edited, or -1 when none. Set by `restorePreset`
	 * and `_setPreset`; while it is set, every sound change re-snapshots that
	 * slot (see `_syncCurrentPreset`), so a restored preset tracks live edits and
	 * is written back to the model on save.
	 */
	currentPreset = -1;
	/**
	 * Guard against the sync handler re-entering: restoring a preset applies
	 * dozens of changes, each of which would otherwise re-snapshot a slot that is
	 * already being written.
	 */
	_syncing = false;
	/** Full models already unzipped (files carry buffers), keyed by name. */
	_cache: Record<string, Model> = {};

	/** Create the manager bound to one engine. */
	constructor(engine: AudioEngine) {
		this.engine = engine;
	}

	// ---- fetch helpers ---------------------------------------------------

	/**
	 * Fetch a model resource. JSON files are parsed; everything else is read as
	 * an ArrayBuffer with streamed progress reported as `notification` events.
	 *
	 * @param file - absolute/relative URL to fetch.
	 * @throws when the response is not ok.
	 */
	async loadFile(file: string): Promise<unknown> {
		const binary = !file.toLowerCase().endsWith('.json');
		const res = await fetch(file);
		if (!res.ok) throw new Error(`Failed to load ${file}: ${res.status} ${res.statusText}`);

		if (!binary) {
			const data = await res.json();
			this.emit('notification', null);
			return data;
		}

		// stream the body so we can report download progress (like axios's
		// onDownloadProgress used to)
		const report = (loaded: number, total: number): void => {
			const perc = total ? ((loaded / total) * 100).toFixed(0) : '0';
			this.emit('notification', { message: '', description: perc + '%' });
		};
		const total = Number(res.headers.get('content-length')) || 0;

		if (res.body && res.body.getReader) {
			const reader = res.body.getReader();
			const chunks = [];
			let loaded = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
				loaded += value.length;
				report(loaded, total);
			}
			const out = new Uint8Array(loaded);
			let offset = 0;
			for (const chunk of chunks) {
				out.set(chunk, offset);
				offset += chunk.length;
			}
			this.emit('notification', null);
			return out.buffer;
		}

		const buffer = await res.arrayBuffer();
		report(buffer.byteLength, total || buffer.byteLength);
		this.emit('notification', null);
		return buffer;
	}

	/** Forward an engine event (ModelManager emits through the engine). */
	emit(event: string, ...args: unknown[]): void {
		this.engine.emit(event, ...args);
	}

	// ---- models ----------------------------------------------------------

	/** Fetch `/models/index.json` and emit `models` (drives the model dropdown). */
	async loadModels() {
		const list = (await this.loadFile(this.engine.modelsPath + '/index.json')) as ModelMeta[];
		this.models = list;
		this.emit('models', list);
		return list;
	}

	/** Load a model by name (or a supplied zip buffer), populating the engine. */
	async loadModel(name: string, zipContent?: ArrayBuffer): Promise<Model | undefined> {
		let model = this._cache[name];
		const cached = model && (model.new || (model.files.length && model.files[0].buffer));

		if (!cached) {
			let zipData = zipContent;
			if (!zipData) {
				try {
					zipData = (await this.loadFile(
						this.engine.modelsPath + '/' + name + '.zip',
					)) as ArrayBuffer;
				} catch (err) {
					this.engine.emit('error', err);
					throw err;
				}
			}

			this.emit('notification', { message: 'Extracting', description: name });

			try {
				const zip = new JSZip();
				const z = await zip.loadAsync(zipData);
				model = JSON.parse(await z.files['index.json'].async('text'));
				model.version = model.version || 1;
				model.presets = Array.isArray(model.presets) ? model.presets : [];
				for (let i = 0; i < model.files.length; i++) {
					if (typeof (model.files[i] as unknown as string) === 'string')
						model.files[i] = { filename: model.files[i] as unknown as string };
					if (z.files[model.files[i].filename])
						model.files[i].buffer = await z.files[model.files[i].filename].async('arraybuffer');
				}
				this.emit('notification', null);
			} catch (err) {
				this.emit('notification', null);
				this.engine.emit('error', err);
				throw err;
			}
		}

		// Always re-populate (destroys the previous sounds and rebuilds them),
		// even on a cache hit — otherwise switching A → B → A would leave B's
		// sounds in the graph while the grid shows A.
		await this.populate(model);
		return model;
	}

	/** Read a File (from the hidden file input) with progress, then load it. */
	loadModelFromFile(
		file: File,
		onProgress?: (e: ProgressEvent<FileReader>) => void,
	): Promise<Model> {
		return new Promise((resolve, reject) => {
			if (!file.name.toLowerCase().endsWith('.zip')) return reject('Format not supported');
			const name = file.name.replace(/(\.zip)/gi, '');
			this.emit('notification', { message: 'Loading', description: '0%' });
			const reader = new FileReader();
			reader.addEventListener('load', (e) => {
				this.loadModel(name, e.target!.result as ArrayBuffer)
					.then((model) => resolve(model!))
					.catch(reject);
			});
			reader.addEventListener('progress', (e) => {
				const perc = e.total ? Math.round((e.loaded / e.total) * 100) : 0;
				this.emit('notification', { message: 'Loading', description: perc + '%' });
				if (onProgress) onProgress(e);
			});
			reader.addEventListener('error', (err) => {
				this.emit('notification', null);
				reject(err);
			});
			reader.addEventListener('abort', () => {
				this.emit('notification', null);
				reject('CANCELLED');
			});
			reader.readAsArrayBuffer(file);
		});
	}

	/**
	 * Build the engine sounds for a model (destroys any previous set). The grid
	 * itself is still rendered by the React layer from the returned model.
	 */
	async populate(model: Model) {
		this.engine.destroy();
		this.model = model;
		this._cache[model.name] = model;
		this.presets = this._normalizeSlots(model.presets);
		this.currentPreset = -1;
		this.emit('presets', this.presets);
		this.emit('currentpreset', this.currentPreset);

		const files = model.files || [];
		for (let idx = 0; idx < files.length; idx++) {
			const file = files[idx];
			const row = model.cols ? Math.floor(idx / model.cols) : 0;
			const col = model.cols ? idx % model.cols : idx;
			const id = row + '-' + col;
			const filename = file ? file.filename : null;
			const params = this._normalizeParams(file && file.params ? file.params : {});
			// v2 files persist their effect chain (possibly empty); legacy v1
			// files have no `effects` key at all and always got one delay — the
			// grid's hover interaction writes params to effect index 0, so keep
			// that default for them instead of loading them with no effect
			const hasSavedEffects = Array.isArray(file && file.params && file.params.effects);
			const effects = hasSavedEffects ? file.params.effects : [];
			const url =
				file && file.buffer
					? URL.createObjectURL(new Blob([file.buffer], { type: file.mimeType }))
					: filename
						? this.engine.audioPath + '/' + model.name + '/' + filename
						: null;
			if (url) {
				this.engine.add(id, url, filename, { ...params, enableAnalyser: false });
				if (!hasSavedEffects) {
					// legacy default: an active delay at index 0
					await this.engine.addEffect(id, 'delay', false);
				} else {
					// restore the whole saved chain in order — this used to
					// hardcode a single 'delay' built from effects[0], silently
					// dropping every other effect (and any non-delay type)
					await Promise.all(
						effects.map((fx) =>
							this.engine.addEffect(
								id,
								fx && fx.type ? fx.type : 'delay',
								fx && fx.bypassed !== undefined ? fx.bypassed : false,
								fx && fx.params,
							),
						),
					);
				}
			}
		}
		this.emit('model', model);
	}

	/**
	 * Legacy model files stored the paused flag as `pause`, but Sound reads
	 * `paused` (its defaults key). Translate on the way in so pausing survives
	 * a save/load round-trip.
	 */
	_normalizeParams(params: SoundSettings): SoundSettings {
		if (params && params.pause !== undefined && params.paused === undefined) {
			return { ...params, paused: params.pause };
		}
		return params;
	}

	/** Create an empty in-memory model (no files) and show its grid. */
	createModel(name: string, cols: number, rows: number): Model {
		if (this.models.filter((m) => m.name.toLowerCase() === name.toLowerCase()).length)
			throw 'Name is already taken!';
		const model: Model = {
			name,
			cols,
			rows,
			files: [],
			presets: [],
			version: MODEL_VERSION,
			new: true,
		};
		this.engine.destroy();
		this.model = model;
		this._cache[name] = model;
		this.presets = this._emptySlots();
		this.currentPreset = -1;
		this.models = [...this.models, { name, cols, rows }];
		this.emit('models', this.models);
		this.emit('presets', this.presets);
		this.emit('currentpreset', this.currentPreset);
		this.emit('model', model);
		return model;
	}

	/** Serialize the current engine state into a zip Blob (does not download). */
	async saveModel(name?: string) {
		const modelName = name || (this.model && this.model.name);
		if (!modelName) return null;
		const model: Model = {
			name: modelName,
			version: MODEL_VERSION,
			files: [],
			cols: this.model ? this.model.cols : 0,
			rows: this.model ? this.model.rows : 0,
			presets: this.presets,
			contentLength: 0,
		};
		const zip = new JSZip();
		const sounds = this.engine.sounds;
		for (let i = 0; i < sounds.length; i++) {
			const sound = sounds[i].sound;
			if (sound._loaded) {
				const blob = new Blob([sound._buffer], { type: sound._mimeType });
				zip.file(sound._filename, blob, { binary: false, base64: true });
				model.contentLength += blob.size;
			}
			model.files.push({
				filename: sound._filename,
				mimeType: fileToMimeType(sound._filename) || undefined,
				params: sound.getSaveState(),
			});
		}
		zip.file('index.json', JSON.stringify(model, null, 4));
		Object.keys(zip.files).forEach(
			(n) =>
				(model.contentLength += (
					zip.files[n] as unknown as { _data: { length: number } }
				)._data.length),
		);
		const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
		return { blob, model };
	}

	/** Serialize the current state and trigger a browser download. */
	async downloadModel(name?: string) {
		const res = await this.saveModel(name);
		if (!res) return undefined;
		this.download(res.blob, res.model.name + '.zip');
		return res.model;
	}

	/** Download a single sound's original audio file. */
	downloadSound(id: string) {
		const item = this.engine.get(id);
		if (!item) return;
		const sound = item.sound;
		const blob = new Blob([sound._buffer], { type: sound._mimeType });
		this.download(blob, sound._filename);
	}

	/** Trigger a browser download of `blob` under `filename` (temporary <a>). */
	download(blob: Blob, filename: string) {
		const a = document.createElement('a');
		a.style.display = 'none';
		document.body.appendChild(a);
		const url = window.URL.createObjectURL(blob);
		a.href = url;
		a.download = filename;
		a.click();
		setTimeout(() => {
			document.body.removeChild(a);
			window.URL.revokeObjectURL(url);
		}, 100);
	}

	// ---- presets ---------------------------------------------------------
	// Presets are slot-addressed: `presets` is always PRESET_SLOTS long and
	// index i belongs to the number key (i === PRESET_SLOTS - 1 ? '0' : i + 1).
	// A null slot is empty — the engine never generates anything until that
	// slot's key is actually pressed, which is when the preset is created.

	/** Snapshot every sound's current settings and store it as a preset. */
	savePreset(name?: string): Preset {
		const sounds: PresetSound[] = this.engine.sounds.map((item: SoundItem) => this._snapshot(item));
		return this._setPreset(this._freeSlot(), { at: Date.now(), name, sounds });
	}

	/**
	 * Randomize every sound and store the result as a preset. `index` addresses
	 * the slot to write (used when a number key creates a preset); without it
	 * the first empty slot is used, and when every slot is taken the result is
	 * only played live (the 'b' action).
	 */
	randomizePreset(index?: number): Preset {
		this.engine.master.stop();
		const sounds = this.engine.sounds;

		sounds.forEach((item: SoundItem) => {
			const id = item.id;
			if (!this.engine.exist(id)) return;
			this.engine.pitch(id, Math.round(Math.random() * 24 - 12));
			this.engine.volume(id, Math.random() * 0.5 + 0.2);
			this.engine.pan(id, Math.random() * 180 - 90);
		});

		const snapshots: PresetSound[] = [];
		sounds.forEach((item: SoundItem, idx: number) => {
			const sound = item.sound;
			const start = Math.random() * sound._duration;
			const end = Math.random() * (sound._duration - start);
			const loopOn = Math.random() < 0.5;
			const lockedOn = Math.random() > 0.75;
			this.engine.loop(item.id, true, { start, end });
			sound._loop = loopOn;
			if (Math.random() < 0.5) this.engine.reverse(item.id, true);
			setTimeout(() => this.engine.lock(item.id, lockedOn), idx * 200);
			// lock() is applied on a stagger, so record the intended value
			snapshots.push(this._snapshot(item, { loop: loopOn, locked: lockedOn }));
		});

		const preset: Preset = { at: Date.now(), sounds: snapshots };
		const slot = index === undefined || index === null ? this._freeSlot() : index;
		if (slot >= 0 && slot < PRESET_SLOTS) this._setPreset(slot, preset);
		this.engine.master.play();
		return preset;
	}

	/** True when the slot already holds a preset (otherwise pressing it creates one). */
	hasPreset(index: number): boolean {
		return !!this.presets[index];
	}

	/**
	 * Restore every sound to a saved preset's settings, and make that slot the
	 * one subsequent edits are written back into (see `currentPreset`).
	 */
	restorePreset(index: number) {
		const preset = this.presets[index];
		if (!preset) return;
		this.currentPreset = index;
		// applying the preset fires a `state` event per changed parameter; suppress
		// the live sync while we do it, or each write re-snapshots the slot
		this._syncing = true;
		try {
			preset.sounds.forEach((cfg: PresetSound) => {
				if (!this.engine.exist(cfg.id)) return;
				const item = this.engine.get(cfg.id);
				const sound = item.sound;
				// unmute first: engine.volume silently skips muted sounds, so the
				// real mute state is re-applied last
				this.engine.mute(cfg.id, false);
				if (cfg.volume !== undefined) this.engine.volume(cfg.id, cfg.volume);
				if (cfg.rate !== undefined) this.engine.rate(cfg.id, cfg.rate);
				if (cfg.pitch !== undefined) this.engine.pitch(cfg.id, cfg.pitch);
				if (cfg.pan !== undefined) this.engine.pan(cfg.id, cfg.pan);
				if (cfg.eq) cfg.eq.forEach((b, i) => this.engine.eq(cfg.id, i, b));
				this.engine.loop(cfg.id, !!cfg.loop, { start: cfg.loopStart, end: cfg.loopEnd });
				if (cfg.reversed !== undefined) this.engine.reverse(cfg.id, !!cfg.reversed);
				if (cfg.locked !== undefined) this.engine.lock(cfg.id, !!cfg.locked);
				// effects: enabled flag first, then per-effect bypass/params override
				if (cfg.effectsEnabled !== undefined && sound.effects && sound.effects.length)
					cfg.effectsEnabled ? sound.enableEffects() : sound.disableEffects();
				if (cfg.effects && cfg.effects.length) {
					cfg.effects.forEach((e: EffectSnapshot) => {
						if (!sound.effects || !sound.effects[e.idx]) return;
						sound.effectBypass(e.idx, !!e.bypassed);
						if (e.params) sound.effectParams(e.idx, e.params);
					});
				}
				this.engine.mute(cfg.id, !!cfg.muted);
			});
		} finally {
			this._syncing = false;
		}
		this.emit('currentpreset', this.currentPreset);
		this.engine.master.play();
	}

	/**
	 * Re-snapshot every sound into the slot being edited, so a restored preset
	 * follows live edits. No-op unless a slot is being edited (see
	 * `currentPreset`) or a restore is in flight.
	 *
	 * Wired to the engine's per-sound `state` event, so any tracked parameter
	 * change (volume/rate/pitch/pan/eq/loop/reverse/lock/mute/effects) is
	 * captured. The `at` stamp is left alone — it records when the slot was
	 * first created, not when it was last touched.
	 */
	_syncCurrentPreset(): void {
		if (this._syncing || this.currentPreset < 0) return;
		const slot = this.presets[this.currentPreset];
		if (!slot) return;
		slot.sounds = this.engine.sounds.map((item: SoundItem) => this._snapshot(item));
		this.emit('presets', this.presets);
	}

	/** Stop tracking edits to the current slot (it stays saved, just unlinked). */
	clearCurrentPreset(): void {
		if (this.currentPreset < 0) return;
		this.currentPreset = -1;
		this.emit('currentpreset', this.currentPreset);
	}

	/** Empty every preset slot and emit the new list. */
	clearPresets() {
		this.presets = this._emptySlots();
		this.currentPreset = -1;
		this.emit('presets', this.presets);
		this.emit('currentpreset', this.currentPreset);
	}

	/** Index of the first empty preset slot, or -1 when all are taken. */
	_freeSlot(): number {
		return this.presets.findIndex((preset) => !preset);
	}

	/** A fresh slot array of PRESET_SLOTS nulls. */
	_emptySlots(): PresetSlot[] {
		return new Array(PRESET_SLOTS).fill(null);
	}

	/** Copy a stored preset list into exactly PRESET_SLOTS slots (null = empty). */
	_normalizeSlots(list?: PresetSlot[]): PresetSlot[] {
		const slots = this._emptySlots();
		if (Array.isArray(list)) {
			const len = Math.min(list.length, PRESET_SLOTS);
			for (let i = 0; i < len; i++) slots[i] = list[i] || null;
		}
		return slots;
	}

	/** Snapshot one sound's saved state (with optional overrides) for a preset. */
	_snapshot(item: SoundItem, overrides: Partial<PresetSound> = {}): PresetSound {
		const state: SoundSettings = item.sound.getSaveState();
		if (state.effects)
			state.effects = state.effects.map((e: EffectSnapshot) => ({
				idx: e.idx,
				type: e.type,
				bypassed: e.bypassed,
				params: e.params,
			}));
		return { id: item.id, ...state, ...overrides };
	}

	/** Write a preset into one slot and emit the updated list. */
	_setPreset(index: number, preset: Preset): Preset {
		if (index < 0 || index >= PRESET_SLOTS) return preset;
		const slots = this._normalizeSlots(this.presets);
		slots[index] = preset;
		this.presets = slots;
		// a freshly written slot becomes the one being edited, so subsequent
		// changes keep it current (see currentPreset)
		this.currentPreset = index;
		this.emit('presets', this.presets);
		this.emit('currentpreset', this.currentPreset);
		return preset;
	}
}
