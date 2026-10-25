/**
 * Stock Radar — Api.gs
 * Messages out: Telegram and email.
 * The Web App API for the phone app is added here in Phase 4.
 */

var Notify = {
  /** Escape text for Telegram's HTML mode. */
  esc: function (s) {
    return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  /** Send an HTML message to your Telegram chat. Long messages are split. Throws if Telegram refuses. */
  telegram: function (html) {
    var token = Secrets.get('TG_BOT_TOKEN'), chat = Secrets.get('TG_CHAT_ID');
    if (!token || !chat) throw new Error('Telegram is not set up. Use Stock Radar → 2. Set up keys.');
    var parts = this.split(String(html), 3800);
    parts.forEach(function (text, i) {
      if (i) Utilities.sleep(1100);
      var res = Http.request('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify({ chat_id: chat, text: text, parse_mode: 'HTML', disable_web_page_preview: true }),
      }, { retries: 2 });
      if (!(res.json && res.json.ok)) {
        var why = res.json && res.json.description ? res.json.description : res.code ? 'HTTP ' + res.code : String(res.text).slice(0, 120);
        throw new Error('Telegram did not accept the message: ' + Secrets.mask(why));
      }
    });
    return parts.length;
  },

  /** Send when Telegram is switched on in Config; never throws. Returns the number of messages sent. */
  safeTelegram: function (html) {
    try {
      if (Config.get('telegram') && Secrets.has('TG_BOT_TOKEN') && Secrets.has('TG_CHAT_ID')) return this.telegram(html);
    } catch (e) {
      console.log('Telegram failed: ' + e.message);
      try { Store.append('ErrorLog', [[new Date(), 'telegram', Secrets.mask(e.message).slice(0, 1000), '']]); } catch (x) { /* sheet missing */ }
    }
    return 0;
  },

  /** Split text into pieces under the limit, at line breaks where possible. */
  split: function (text, max) {
    if (text.length <= max) return [text];
    var out = [], cur = '';
    text.split('\n').forEach(function (line) {
      while (line.length > max) { // a single very long line
        if (cur) { out.push(cur); cur = ''; }
        out.push(line.slice(0, max));
        line = line.slice(max);
      }
      if ((cur ? cur.length + 1 : 0) + line.length > max) { out.push(cur); cur = line; }
      else cur = cur ? cur + '\n' + line : line;
    });
    if (cur) out.push(cur);
    return out;
  },

  /** Email yourself (the Google account that owns this sheet). */
  email: function (subject, html) {
    var to = Session.getEffectiveUser().getEmail();
    if (!to) throw new Error('Could not read your Google account email');
    if (MailApp.getRemainingDailyQuota() < 1) throw new Error('The daily email limit is used up');
    MailApp.sendEmail({ to: to, subject: 'Stock Radar: ' + subject, htmlBody: html, name: 'Stock Radar' });
  },

  /** Turn a Telegram-style message into a simple HTML email body. */
  htmlFromTelegram: function (text) {
    var body = String(text).split('\n').map(function (line) { return line === '' ? '<br>' : '<div>' + line + '</div>'; }).join('');
    return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#0E242B;max-width:560px">' + body +
      '<p style="color:#58727A;font-size:12px;margin-top:18px">Stock Radar is a personal analysis tool, not investment advice.</p></div>';
  },
};
