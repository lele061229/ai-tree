const input = document.getElementById('url');
const error = document.getElementById('error');
const save = document.getElementById('save');
const cancel = document.getElementById('cancel');

const info = window.koSettings.load();
input.value = info.serverUrl || '';
document.getElementById('where').textContent = info.configPath;

input.focus();
if (input.value) input.select();

async function submit() {
  error.textContent = '';
  save.disabled = true;
  const result = await window.koSettings.save(input.value);
  save.disabled = false;
  if (!result || !result.ok) {
    error.textContent = (result && result.reason) || '保存失败';
  }
}

save.addEventListener('click', submit);
input.addEventListener('keydown', event => { if (event.key === 'Enter') submit(); });
cancel.addEventListener('click', () => window.close());
