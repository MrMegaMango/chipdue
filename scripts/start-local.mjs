const host = process.env.HOST ?? '127.0.0.1';
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

if (!loopbackHosts.has(host) && process.env.CARDDUE_ALLOW_REMOTE !== '1') {
	throw new Error(
		'Refusing to bind ChipDue beyond loopback. Set CARDDUE_ALLOW_REMOTE=1 only after a security review.'
	);
}

process.env.HOST = host;
process.env.PORT ??= '4173';
process.env.ORIGIN ??= `http://${host.includes(':') ? `[${host}]` : host}:${process.env.PORT}`;

await import('../build/index.js');
