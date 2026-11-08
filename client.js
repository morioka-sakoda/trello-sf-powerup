/* global TrelloPowerUp */
var CFG = window.SF_POWERUP_CONFIG;
var SF_ICON = 'https://cdn.jsdelivr.net/npm/simple-icons@11.14.0/icons/salesforce.svg';

// カード画面のボタンを押したとき
function openTaskPopup(t) {
  return t.getRestApi().isAuthorized().then(function (authorized) {
    if (!authorized) {
      return t.popup({ title: 'Trelloアカウントの確認', url: './auth.html', height: 140 });
    }
    return t.popup({ title: 'SalesforceにToDoを発行', url: './popup.html', height: 420 });
  });
}

TrelloPowerUp.initialize({
  // カード詳細の右側に出るボタン
  'card-buttons': function () {
    return [{
      icon: SF_ICON,
      text: 'SalesforceにToDo発行',
      callback: openTaskPopup
    }];
  },

  // ボード上のカード（前面）に出るバッジ
  'card-badges': function (t) {
    return t.get('card', 'shared', 'sfTask').then(function (task) {
      if (!task) return [];
      return [{ text: 'SF ToDo済', color: 'blue' }];
    });
  },

  // カード詳細に出るバッジ（クリックでSalesforceを開く）
  'card-detail-badges': function (t) {
    return t.get('card', 'shared', 'sfTask').then(function (task) {
      if (!task) return [];
            return [{
        title: 'Salesforce',
        text: 'ToDoを開く',
        color: 'blue',
        url: task.url,
        target: 'Salesforce'
      }];
    });
  },

  // Power-Up設定画面での認証状態
  'authorization-status': function (t) {
    return t.getRestApi().isAuthorized().then(function (a) { return { authorized: a }; });
  },
  'show-authorization': function (t) {
    return t.popup({ title: 'Trelloアカウントの確認', url: './auth.html', height: 140 });
  }
}, {
  appKey: CFG.appKey,
  appName: CFG.appName
});
