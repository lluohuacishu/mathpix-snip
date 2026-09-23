try {
  const r = await fetch('http://127.0.0.1:47831/api/health', { signal: AbortSignal.timeout(1200) });
  process.exit((await r.json()).app === 'mathpix-snip-local' ? 0 : 1);
} catch { process.exit(1); }
