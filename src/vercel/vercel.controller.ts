import { Body, Controller, Get, Header, Headers, Post } from '@nestjs/common';
import { VercelTelegramService } from './vercel-telegram.service';
import { Pool } from 'pg';

@Controller()
export class VercelController {
  constructor(private readonly telegram: VercelTelegramService) {}

  @Get()
  root() {
    return { project: 'aisora', runtime: 'vercel', message: 'Aisora cloud test API', health: '/health' };
  }

  @Get('health')
  health() {
    return {
      status: 'ok',
      runtime: 'vercel',
      mode: 'webhook-smoke-test',
      telegramConfigured: this.telegram.configured(),
      aisSyncEnabled: false,
      submissionEnabled: false,
    };
  }

  /**
   * Validate Neon connectivity without disclosing connection details or
   * requiring any migrations. A short-lived pool avoids keeping connections
   * alive in a Vercel serverless invocation.
   */
  @Get('health/db')
  @Header('Cache-Control', 'no-store')
  async databaseHealth() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      return { status: 'not_configured', database: 'postgresql', tablesChecked: false };
    }
    const pool = new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 4000,
      idleTimeoutMillis: 1000,
    });
    try {
      await pool.query('SELECT 1');
      return { status: 'connected', database: 'postgresql', tablesChecked: false };
    } catch {
      // Avoid leaking usernames, host names or Neon credentials.
      return { status: 'unavailable', database: 'postgresql', tablesChecked: false };
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  @Get('security/keygen')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store, private')
  keygenPage() {
    // Uses the phone's Web Crypto API: the key is generated in the browser,
    // not by our server, and is never submitted or saved by this page.
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aisora — генерация ключа</title>
<style>
body{font:16px system-ui;background:#f5f8fa;color:#152535;margin:0;padding:25px}
main{max-width:540px;margin:8vh auto;background:#fff;border-radius:20px;padding:25px}
textarea{width:100%;box-sizing:border-box;min-height:85px;padding:12px;border-radius:10px}
button{padding:12px 18px;background:#152535;color:white;border:0;border-radius:10px}
p{line-height:1.5}small{color:#516373}
</style></head><body><main><h2>🔐 Ключ Aisora</h2>
<p>Создай 32-байтный ключ шифрования AES-256-GCM. Он генерируется <b>только в твоём браузере</b>, без отправки на сервер.</p>
<button id="generate" type="button">Создать новый ключ</button>
<p><textarea id="result" readonly autocomplete="off" spellcheck="false"></textarea></p>
<button id="copy" type="button">Копировать ключ</button>
<p><small>Сохрани один и тот же ключ в секретах Vercel и GitHub Actions под именем CREDENTIALS_MASTER_KEY. Никому его не присылай. Если потерять ключ, уже зашифрованные пароли АИС восстановить нельзя.</small></p>
</main><script>
document.getElementById('generate').onclick=()=>{
 const bytes=new Uint8Array(32);
 crypto.getRandomValues(bytes);
 let raw=''; for (const value of bytes) raw+=String.fromCharCode(value);
 document.getElementById('result').value=btoa(raw);
};
document.getElementById('copy').onclick=async()=>{
 await navigator.clipboard.writeText(document.getElementById('result').value);
};
</script></body></html>`;
  }

  @Get('telegram/setup')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  setupPage() {
    // The operator enters only the webhook secret, never the BotFather token.
    // This page doesn't persist the secret to cookies or browser storage.
    return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aisora — Telegram Setup</title>
<style>
body{margin:0;background:#f5f8fa;color:#162838;font:16px system-ui,sans-serif}
main{max-width:480px;margin:10vh auto;padding:28px;background:white;border-radius:18px;box-shadow:0 8px 35px #132b4515}
h1{font-size:24px;margin:0 0 12px}p{line-height:1.6}
label{display:block;font-weight:600;margin:22px 0 9px}
input{width:100%;box-sizing:border-box;border:1px solid #bfcbd2;border-radius:10px;padding:13px;font-size:16px}
button{width:100%;margin-top:16px;border:0;border-radius:10px;padding:14px;background:#152535;color:white;font-size:16px;cursor:pointer}
small{display:block;color:#647582;line-height:1.5;margin-top:15px}
#result{margin-top:16px;white-space:pre-wrap;overflow-wrap:anywhere}
</style></head>
<body><main><h1>☁️ Aisora — Telegram</h1>
<p>Зарегистрируй тестовый бот на Vercel. Введи <b>TELEGRAM_WEBHOOK_SECRET</b>, который сохранил в настройках проекта. Токен BotFather вводить не нужно.</p>
<form id="setup"><label for="secret">Секрет webhook</label>
<input id="secret" type="password" required autocomplete="off" spellcheck="false">
<button id="submit" type="submit">Подключить Telegram</button></form>
<div id="result" role="status" aria-live="polite"></div>
<small>Настройка использует HTTPS и не сохраняет ключ в браузере. Нужен отдельный тестовый бот, не используемый локальным polling.</small>
</main><script>
document.getElementById('setup').addEventListener('submit',async(e)=>{
e.preventDefault();
const secret=document.getElementById('secret').value;
const btn=document.getElementById('submit');
btn.disabled=true;
const output=document.getElementById('result');
output.textContent='Подключаю...';
try{
 const res=await fetch('/telegram/setup',{method:'POST',headers:{'content-type':'application/json','x-aisora-setup-secret':secret},body:'{}',cache:'no-store'});
 const result=await res.json();
 output.textContent=res.ok?'✅ Webhook подключён! Теперь проверь /ping у тестового бота.':'Ошибка настройки: HTTP '+res.status;
}catch(e){output.textContent='Ошибка сети. Попробуй снова.'}
document.getElementById('secret').value='';
btn.disabled=false;
});
</script></body></html>`;
  }

  @Post('telegram/setup')
  @Header('Cache-Control', 'no-store')
  registerWebhook(@Headers('x-aisora-setup-secret') secret: string | undefined) {
    return this.telegram.registerWebhook(secret);
  }

  @Post('telegram/webhook')
  async telegramWebhook(
    @Headers('x-telegram-bot-api-secret-token') providedSecret: string | undefined,
    @Body() update: unknown,
  ) {
    return this.telegram.handle(providedSecret, update);
  }
}
