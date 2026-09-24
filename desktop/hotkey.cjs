const DEFAULT_HOTKEY = 'Alt+Shift+Q';
function normalizeHotkey(value) {
  if (typeof value !== 'string' || value.length > 80) throw new Error('请输入有效的快捷键组合。');
  const parts = value.replace(/\s/g, '').split('+'), key = parts.pop()?.toUpperCase();
  const aliases = { ctrl:'Ctrl', control:'Ctrl', alt:'Alt', shift:'Shift', win:'Super', super:'Super' };
  const modifiers = parts.map(part => aliases[part.toLowerCase()]);
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4]))$/.test(key) || modifiers.includes(undefined) || new Set(modifiers).size !== modifiers.length || !modifiers.some(part => ['Ctrl','Alt','Super'].includes(part)))
    throw new Error('请使用 Ctrl、Alt、Shift、Win 与字母、数字或 F1–F24 组合，至少包含 Ctrl、Alt 或 Win。例如 Alt+Shift+Q。');
  return [...['Ctrl','Alt','Shift','Super'].filter(part => modifiers.includes(part)), key].join('+');
}
class HotkeyController {
  constructor({ shortcuts, capture, persist, initial = DEFAULT_HOTKEY }) {
    this.shortcuts = shortcuts; this.capture = capture; this.persist = persist; this.hotkey = normalizeHotkey(initial); this.queue = Promise.resolve();
  }
  register() { return this.shortcuts.isRegistered(this.hotkey) || this.shortcuts.register(this.hotkey, this.capture); }
  set(value) {
    const operation = this.queue.catch(() => {}).then(async () => {
      const next = normalizeHotkey(value), previous = this.hotkey;
      if (next === previous) { if (!this.register()) throw new Error('这个快捷键已被其他程序占用，请换一个组合。'); return next; }
      if (!this.shortcuts.register(next, this.capture)) throw new Error('这个快捷键已被其他程序占用或系统保留，原快捷键仍然有效。');
      try { await this.persist(next); }
      catch { this.shortcuts.unregister(next); throw new Error('快捷键保存失败，原快捷键仍然有效。'); }
      this.hotkey = next; this.shortcuts.unregister(previous); return next;
    });
    this.queue = operation; return operation;
  }
}
module.exports = { DEFAULT_HOTKEY, normalizeHotkey, HotkeyController };
