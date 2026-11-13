window.permission.onDevices(devices => { document.getElementById('explanation').textContent = `Разрешить Кругу доступ к ${devices}?`; });
document.getElementById('cancel').addEventListener('click', () => window.permission.choose(false));
document.getElementById('share').addEventListener('click', () => window.permission.choose(true));
