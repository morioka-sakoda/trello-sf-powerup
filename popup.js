/* global TrelloPowerUp */
var CFG = window.SF_POWERUP_CONFIG;
var t = TrelloPowerUp.iframe({ appKey: CFG.appKey, appName: CFG.appName });

var $ = function (id) { return document.getElementById(id); };
var card = null;
var candidates = [];

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

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function showMsg(text, isErr) {
  $('msg').textContent = text;
  $('msg').className = isErr ? 'err' : '';
  t.sizeTo('body');
}

// GASを呼ぶ（Trelloトークンを付けて送る）
function callGas(payload) {
  return t.getRestApi().getToken().then(function (token) {
    if (!token) throw new Error('Trelloアカウントの確認が必要です。設定からやり直してください');
    payload.trelloToken = token;
    // text/plain で送るとプリフライトが発生せず、GASでも受け取れる
    return fetch(CFG.gasUrl, { method: 'POST', body: JSON.stringify(payload) });
  }).then(function (r) {
    return r.json();
  }).then(function (data) {
    if (!data.ok) throw new Error(data.error || '処理に失敗しました');
    return data;
  });
}

function renderCandidates(data) {
  candidates = data.candidates || [];
  var html = '';
  if (!candidates.length) {
    html = '<div class="hint">' + esc(data.hint || '該当するお客様が見つかりませんでした。必要なら下に関連先を直接入力してください') + '</div>';
  } else {
    if (!data.matchedByName) {
      html += '<div class="note">名字が一致する候補がないため、ナンバーだけで探した結果です。確認して選んでください</div>';
    }
    var autoPick = data.matchedByName && candidates.length === 1;
    candidates.forEach(function (c, i) {
      html += '<label><input type="radio" name="cust" value="' + i + '"' + (autoPick ? ' checked' : '') + '>'
        + '<span>' + esc(c.accountName) + '<br><span class="sub">' + esc(c.vehicleName) + '　' + esc(c.plate) + '</span></span></label>';
    });
  }
  html += '<label><input type="radio" name="cust" value=""' + (candidates.length && data.matchedByName && candidates.length === 1 ? '' : ' checked') + '>'
    + '<span>お客様を関連付けない</span></label>';
  $('cand').innerHTML = html;
  t.sizeTo('body');
}

function loadCandidates() {
  callGas({ action: 'search', cardId: card.id, cardName: card.name })
    .then(renderCandidates)
    .catch(function (err) {
      $('cand').innerHTML = '<div class="hint">お客様を検索できませんでした（' + esc(err.message) + '）</div>';
      t.sizeTo('body');
    });
}

function showForm() {
  $('done').hidden = true;
  $('f').hidden = false;
  $('subject').value = card.name;
  $('due').value = toLocalDate(card.due);
  t.sizeTo('body');
  loadCandidates();
}

Promise.all([
  t.card('id', 'name', 'desc', 'url', 'due'),
  t.get('card', 'shared', 'sfTask')
]).then(function (res) {
  card = res[0];
  var task = res[1];
  if (task) {
    $('done').hidden = false;
    $('open').href = task.url;
    $('open').onclick = function () { setTimeout(function () { t.closePopup(); }, 300); };
    $('redo').onclick = showForm;
    t.sizeTo('body');
  } else {
    showForm();
  }
});

$('f').addEventListener('submit', function (e) {
  e.preventDefault();
  var manual = extractSfId($('whatId').value);
  if (manual === null) { showMsg('関連先のURLまたはIDの形式が正しくありません', true); return; }

  var picked = document.querySelector('input[name="cust"]:checked');
  var cand = picked && picked.value !== '' ? candidates[Number(picked.value)] : null;

  $('send').disabled = true;
  showMsg('発行しています…');

  callGas({
    cardId: card.id,
    cardUrl: card.url,
    cardDesc: card.desc,
    subject: $('subject').value.trim(),
    dueDate: $('due').value,
    priority: $('priority').value,
    whatId: manual || (cand ? cand.accountId : ''),
    whoId: !manual && cand ? cand.personContactId : '',
    vehicleLabel: !manual && cand ? (cand.vehicleName + ' ' + cand.plate) : '',
    memo: $('memo').value.trim()
  }).then(function (data) {
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
