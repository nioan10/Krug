const sources = document.getElementById('sources');
const audio = document.getElementById('audio');
const share = document.getElementById('share');
let selected;
window.picker.onSources(items => {
  for (const item of items) {
    const button = document.createElement('button'); button.className = 'source';
    const image = document.createElement('img'); image.src = item.image; image.alt = '';
    const label = document.createElement('span'); label.textContent = item.name;
    button.append(image, label); sources.append(button);
    button.addEventListener('click', () => {
      document.querySelectorAll('.source').forEach(el => el.classList.remove('selected'));
      button.classList.add('selected'); selected = item; share.disabled = false;
      audio.disabled = !item.id.startsWith('window:'); if (audio.disabled) audio.checked = false;
    });
  }
});
share.addEventListener('click', () => { if (selected) window.picker.choose(selected.id, audio.checked); });
document.getElementById('cancel').addEventListener('click', () => window.picker.cancel());
