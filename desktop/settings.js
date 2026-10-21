const input = document.getElementById('url');
const error = document.getElementById('error');
const save = document.getElementById('save');
const cancel = document.getElementById('cancel');
const useLocal = document.getElementById('useLocal');
const mode = document.getElementById('mode');

const info = window.koSettings.load();
input.value = info.serverUrl && info.serverUrl !== 'local' ? info.serverUrl : '';
mode.textContent = (!info.serverUrl || info.serverUrl === 'local') ? '本机数据（本地优先）' : ('云服务器 ' + info.serverUrl);
document.getElementById('where').textContent = info.configPath;

input.focus();

async function submit() {
  error.textContent = '';
  save.disabled = true;
  const result = await window.koSettings.save(input.value);
  save.disabled = false;
  if (!result || !result.ok) {
    error.textContent = (result && result.reason) || '保存失败';
  }
}

async function goLocal() {
  error.textContent = '';
  useLocal.disabled = true;
  const result = await window.koSettings.save('local');
  useLocal.disabled = false;
  if (!result || !result.ok) error.textContent = (result && result.reason) || '切换失败';
}

save.addEventListener('click', submit);
useLocal.addEventListener('click', goLocal);
input.addEventListener('keydown', event => { if (event.key === 'Enter') submit(); });
cancel.addEventListener('click', () => window.close());
