// Browser shim for Node's `events` module — just enough EventEmitter for the
// engine (on/once/off/emit/removeListener/setMaxListeners/listenerCount).
export class EventEmitter {
	constructor() {
		this._events = new Map();
		this._max = 10;
	}
	setMaxListeners(n) {
		this._max = n;
		return this;
	}
	getMaxListeners() {
		return this._max;
	}
	addListener(type, fn) {
		if (!this._events.has(type)) this._events.set(type, []);
		this._events.get(type).push(fn);
		return this;
	}
	on(type, fn) {
		return this.addListener(type, fn);
	}
	prependListener(type, fn) {
		if (!this._events.has(type)) this._events.set(type, []);
		this._events.get(type).unshift(fn);
		return this;
	}
	once(type, fn) {
		const wrapped = (...args) => {
			this.removeListener(type, wrapped);
			fn(...args);
		};
		wrapped.listener = fn;
		return this.addListener(type, wrapped);
	}
	prependOnceListener(type, fn) {
		const wrapped = (...args) => {
			this.removeListener(type, wrapped);
			fn(...args);
		};
		wrapped.listener = fn;
		return this.prependListener(type, wrapped);
	}
	removeListener(type, fn) {
		const list = this._events.get(type);
		if (!list) return this;
		const i = list.findIndex((f) => f === fn || f.listener === fn);
		if (i >= 0) list.splice(i, 1);
		return this;
	}
	off(type, fn) {
		return this.removeListener(type, fn);
	}
	removeAllListeners(type) {
		if (type === undefined) this._events.clear();
		else this._events.delete(type);
		return this;
	}
	listeners(type) {
		return (this._events.get(type) || []).map((f) => f.listener || f);
	}
	rawListeners(type) {
		return (this._events.get(type) || []).slice();
	}
	listenerCount(type) {
		return (this._events.get(type) || []).length;
	}
	eventNames() {
		return [...this._events.keys()];
	}
	emit(type, ...args) {
		const list = this._events.get(type);
		if (!list || !list.length) return false;
		for (const fn of list.slice()) fn(...args);
		return true;
	}
}

export default EventEmitter;
