// Browser shim for `moment` — only used to name recordings. No parsing needed.
export default function moment() {
	return {
		format: () => {
			const d = new Date();
			const p = (n) => String(n).padStart(2, '0');
			return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
		},
	};
}
