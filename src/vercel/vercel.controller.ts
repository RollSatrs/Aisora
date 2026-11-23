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
