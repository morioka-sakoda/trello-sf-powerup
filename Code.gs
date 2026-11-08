/**
 * Trello Power-Up → Salesforce ToDo 発行用 中継Webアプリ
 *
 * スクリプトプロパティ:
 *   TRELLO_API_KEY / ALLOWED_ORG_ID（カンマ区切り可） / SF_DOMAIN / SF_CLIENT_ID / SF_CLIENT_SECRET
 *   OWNER_MAP / DEFAULT_OWNER_ID / TASK_STATUS
 */
var API_VER = 'v62.0';
var PROPS = PropertiesService.getScriptProperties();

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    if (!req.cardId) throw new Error('カードIDがありません');

    var member = verifyTrelloMember_(req.trelloToken);
    verifyCardWorkspace_(req.trelloToken, req.cardId);

    // お客様候補の検索
    if (req.action === 'search') {
      var found = searchCustomer_(req.cardName);
      return json_({ ok: true, candidates: found.candidates, matchedByName: found.matchedByName, hint: found.hint });
    }

    // ToDo発行
    if (!req.subject) throw new Error('件名がありません');
    var ownerId = resolveOwner_(member);
    var result = upsertTask_(req, ownerId, member);
    return json_({ ok: true, taskId: result.id, created: result.created, url: result.url });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: String(err.message || err) });
  }
}

/** Trelloトークンから押した人を特定 */
function verifyTrelloMember_(token) {
  if (!token) throw new Error('Trelloアカウントの確認が必要です');
  var url = 'https://api.trello.com/1/members/me?fields=id,fullName,username'
    + '&key=' + encodeURIComponent(PROPS.getProperty('TRELLO_API_KEY'))
    + '&token=' + encodeURIComponent(token);
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Trelloアカウントを確認できませんでした。設定から再認証してください');
  return JSON.parse(res.getContentText());
}

/** カードのボードが、許可したワークスペースに属しているか確認 */
function verifyCardWorkspace_(token, cardId) {
  var allowed = (PROPS.getProperty('ALLOWED_ORG_ID') || '')
    .replace(/["\s]/g, '').split(',').filter(String);
  if (!allowed.length) return;

  var url = 'https://api.trello.com/1/cards/' + encodeURIComponent(cardId)
    + '?fields=idBoard&board=true&board_fields=name,idOrganization'
    + '&key=' + encodeURIComponent(PROPS.getProperty('TRELLO_API_KEY'))
    + '&token=' + encodeURIComponent(token);
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('このカードを確認できませんでした。カードを開き直してから再度お試しください');
  }
  var c = JSON.parse(res.getContentText());
  var orgId = c.board && c.board.idOrganization;
  if (allowed.indexOf(orgId) === -1) {
    throw new Error('ボード「' + (c.board ? c.board.name : '') + '」は発行対象のワークスペースではありません'
      + '（このボードのワークスペースID: ' + (orgId || 'なし') + '）');
  }
}

/**
 * カード名（例: 上村 タント 1309）から、ナンバー末尾＋名字で車両を検索し、名義のお客様を返す
 * 名字で見つからなければ、ナンバーだけで候補を返す
 */
function searchCustomer_(cardName) {
  var text = String(cardName || '').normalize('NFKC').trim();
  var tokens = text.split(/\s+/).filter(String);
  var nums = tokens.filter(function (s) { return /^\d{1,4}$/.test(s); });
  var words = tokens.filter(function (s) { return !/\d/.test(s); });
  var surname = words[0] || '';

  if (!nums.length) {
    return { candidates: [], matchedByName: false, hint: 'カード名にナンバーが見つからないため、自動検索できません' };
  }

  var plateCond = '(' + nums.map(function (n) {
    return "Veh_RegistNumber__c LIKE '% " + soqlEsc_(n) + "'";
  }).join(' OR ') + ')';
  var base = 'SELECT Id, Veh_RegistNumber__c, Veh_Name__c, Veh_Ref_Account__c, Veh_Ref_Account__r.Name'
    + ' FROM Vehicle__c WHERE Veh_Ref_Account__c != null AND ' + plateCond;

  var recs = [];
  if (surname) {
    recs = sfQuery_(base + " AND Veh_Ref_Account__r.Name LIKE '" + soqlEsc_(surname) + "%' LIMIT 10");
  }
  var matchedByName = recs.length > 0;
  if (!recs.length) recs = sfQuery_(base + ' LIMIT 10');

  // 同じお客様・同じ車両の重複を除く
  var seen = {};
  var candidates = [];
  recs.forEach(function (r) {
    var key = r.Veh_Ref_Account__c + '|' + r.Id;
    if (seen[key]) return;
    seen[key] = true;
    candidates.push({
      accountId: r.Veh_Ref_Account__c,
      accountName: r.Veh_Ref_Account__r ? r.Veh_Ref_Account__r.Name : '',
      vehicleId: r.Id,
      vehicleName: r.Veh_Name__c || '',
      plate: r.Veh_RegistNumber__c || ''
    });
  });
  return { candidates: candidates, matchedByName: matchedByName, hint: '' };
}

/** TrelloメンバーID → SalesforceユーザーID */
function resolveOwner_(member) {
  var raw = (PROPS.getProperty('OWNER_MAP') || '{}').replace(/[“”]/g, '"');
  var map;
  try { map = JSON.parse(raw); } catch (e) { throw new Error('OWNER_MAP の書式が正しくありません'); }
  var owner = map[member.id] || PROPS.getProperty('DEFAULT_OWNER_ID');
  if (!owner) {
    throw new Error(member.fullName + 'さんは担当者の対応表に未登録です（TrelloメンバーID: ' + member.id + '）');
  }
  return owner;
}

/** カードIDで既存ToDoを探し、あれば更新・なければ作成 */
function upsertTask_(req, ownerId, member) {
  var sf = getSfToken_();
  var base = sf.instance_url + '/services/data/' + API_VER;
  var headers = { Authorization: 'Bearer ' + sf.access_token };

  var desc = [
    req.memo || '',
    req.vehicleLabel ? '対象車両: ' + req.vehicleLabel : '',
    'Trelloカード: ' + req.cardUrl,
    '発行者: ' + member.fullName,
    req.cardDesc ? '---\n' + req.cardDesc : ''
  ].filter(String).join('\n\n').slice(0, 32000);

  var body = {
    Subject: req.subject.slice(0, 255),
    Description: desc,
    OwnerId: ownerId,
    Priority: req.priority || 'Normal',
    Status: PROPS.getProperty('TASK_STATUS') || 'Not Started',
    ActivityDate: req.dueDate || null,
    Trello_Card_Id__c: req.cardId,
    WhatId: null,
    WhoId: null
  };
  if (req.whatId) {
    // 003=取引先責任者, 00Q=リード は WhoId、それ以外（取引先など）は WhatId
    var prefix = req.whatId.slice(0, 3);
    if (prefix === '003' || prefix === '00Q') body.WhoId = req.whatId;
    else body.WhatId = req.whatId;
  }

  var existing = sfQuery_("SELECT Id FROM Task WHERE Trello_Card_Id__c = '" + soqlEsc_(req.cardId) + "' LIMIT 1")[0];

  var id, created;
  if (existing) {
    sfFetch_(base + '/sobjects/Task/' + existing.Id, {
      method: 'patch', contentType: 'application/json', headers: headers, payload: JSON.stringify(body)
    });
    id = existing.Id; created = false;
  } else {
    var r = sfFetch_(base + '/sobjects/Task', {
      method: 'post', contentType: 'application/json', headers: headers, payload: JSON.stringify(body)
    });
    id = r.id; created = true;
  }
  return { id: id, created: created, url: sf.instance_url + '/lightning/r/Task/' + id + '/view' };
}

/** SOQLを実行してレコード配列を返す */
function sfQuery_(soql) {
  var sf = getSfToken_();
  var url = sf.instance_url + '/services/data/' + API_VER + '/query?q=' + encodeURIComponent(soql);
  var q = sfFetch_(url, { headers: { Authorization: 'Bearer ' + sf.access_token } });
  return q.records || [];
}

function soqlEsc_(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Client Credentials フローでアクセストークン取得（25分キャッシュ） */
function getSfToken_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('sf_token');
  if (hit) return JSON.parse(hit);

  var res = UrlFetchApp.fetch(PROPS.getProperty('SF_DOMAIN') + '/services/oauth2/token', {
    method: 'post',
    payload: {
      grant_type: 'client_credentials',
      client_id: PROPS.getProperty('SF_CLIENT_ID'),
      client_secret: PROPS.getProperty('SF_CLIENT_SECRET')
    },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('Salesforceに接続できません: ' + res.getContentText());
  var tok = JSON.parse(res.getContentText());
  cache.put('sf_token', JSON.stringify(tok), 1500);
  return tok;
}

function sfFetch_(url, opt) {
  opt.muteHttpExceptions = true;
  var res = UrlFetchApp.fetch(url, opt);
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code >= 300) {
    var msg = text;
    try { msg = JSON.parse(text)[0].message; } catch (_) {}
    throw new Error('Salesforceエラー: ' + msg);
  }
  return text ? JSON.parse(text) : {};
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 動作確認用：エディタから実行 */
function testSalesforceConnection() {
  var sf = getSfToken_();
  console.log('接続OK: ' + sf.instance_url);
}

/** 動作確認用：お客様検索をエディタから試す */
function testSearchCustomer() {
  console.log(JSON.stringify(searchCustomer_('上村　タント　1309'), null, 2));
}
