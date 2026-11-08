/* global TrelloPowerUp */
var CFG = window.SF_POWERUP_CONFIG;
var t = TrelloPowerUp.iframe({ appKey: CFG.appKey, appName: CFG.appName });

var $ = function (id) { return document.getElementById(id); };
var card = null;

function toLocalDate(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  var p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// SalesforceのURLまたはIDから15/18桁のIDを取り出す
function extractSfId(text) {
  text = (text || '').trim();
  if (!text) return '';
  var m = text.match(/(?:^|\/)([a-zA-Z0-9]{18}|[a-zA-Z0-9]{15})(?=\/|\?|$)/);
  return m ? m[1] : null;
}

function showMsg(text, isErr) {
  $('msg').textContent = text;
  $('msg').className = isErr ? 'err' : '';
  t.sizeTo('body');
}

function showForm() {
  $('done').hidden = true;
  $('f').hidden = false;
  $('subject').value = card.name;
  $('due').value = toLocalDate(card.due);
  t.sizeTo('body');
}

Promise.all([
  t.card('id', 'name', 'desc', 'url', 'due'),
  t.get('card', 'shared', 'sfTask')
]).then(function (res) {
  card = res[0];
  var task = res[1];
  if (task) {
    $('done').hidden = false;
    $('open').onclick = function () { t.navigate({ url: task.url }); t.closePopup(); };
    $('redo').onclick = showForm;
    t.sizeTo('body');
  } else {
    showForm();
  }
});

$('f').addEventListener('submit', function (e) {
  e.preventDefault();
  var whatId = extractSfId($('whatId').value);
  if (whatId === null) { showMsg('関連先のURLまたはIDの形式が正しくありません', true); return; }

  $('send').disabled = true;
  showMsg('発行しています…');

  t.getRestApi().getToken().then(function (token) {
    if (!token) throw new Error('Trelloアカウントの確認が必要です。設定からやり直してください');
    var payload = {
      trelloToken: token,
      cardId: card.id,
      cardUrl: card.url,
      cardDesc: card.desc,
      subject: $('subject').value.trim(),
      dueDate: $('due').value,
      priority: $('priority').value,
      whatId: whatId,
      memo: $('memo').value.trim()
    };
    // text/plain で送るとプリフライトが発生せず、GASでも受け取れる
    return fetch(CFG.gasUrl, { method: 'POST', body: JSON.stringify(payload) });
  }).then(function (r) {
    return r.json();
  }).then(function (data) {
    if (!data.ok) throw new Error(data.error || '発行に失敗しました');
    return t.set('card', 'shared', 'sfTask', { id: data.taskId, url: data.url }).then(function () {
      t.alert({
        message: data.created ? 'SalesforceにToDoを発行しました' : 'SalesforceのToDoを更新しました',
        display: 'success', duration: 4
      });
      t.closePopup();
    });
  }).catch(function (err) {
    $('send').disabled = false;
    showMsg(err.message, true);
  });
});
