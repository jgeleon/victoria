# Despliegue del panel (Railway / Render)

Guía para publicar el panel web (`web/server.js`) en la nube. El panel corre de
forma continua, lanza el bot y guarda las órdenes/logs en disco, por eso necesita
un servicio "persistente" con **volumen de disco** (no sirve Vercel/serverless).

> El código ya está preparado: el servidor usa `process.env.PORT` (lo pone la
> plataforma) y guarda los datos en `process.env.DATA_DIR` (apúntalo al volumen).

---

## 0) Requisitos previos

1. Tener el proyecto en un repositorio de **GitHub** (privado, de preferencia).
   Desde la carpeta del proyecto:
   ```bash
   git add -A
   git commit -m "Panel web listo para desplegar"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/us-visa-bot.git
   git push -u origin main
   ```
2. `web/data/` está en `.gitignore` (no se sube): las órdenes y logs viven en el
   **volumen** del servidor, no en el repo.

---

## Opción A — Railway

1. Entra a https://railway.app → **New Project** → **Deploy from GitHub repo** →
   elige tu repositorio.
2. Railway detecta Node y lo construye solo. Si te pide **Start Command**, pon:
   ```
   npm start
   ```
   (equivale a `node web/server.js`).
3. **Volumen persistente** (para no perder órdenes/logs en cada redepliegue):
   - En el servicio → pestaña **Volumes** → **New Volume**.
   - Mount path: `/data`
4. **Variables** (pestaña *Variables*):
   - `DATA_DIR` = `/data`
   - (No pongas `PORT`: Railway lo asigna automáticamente.)
5. En **Settings → Networking → Generate Domain** para obtener la URL pública.
6. Abre esa URL: ahí está tu panel.

---

## Opción B — Render

1. Entra a https://render.com → **New** → **Web Service** → conecta tu repo de GitHub.
2. Configura:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: elige un plan **de pago** (ver notas abajo).
3. **Disco persistente**: pestaña **Disks** → **Add Disk**:
   - Name: `data`
   - Mount Path: `/data`
   - Size: 1 GB es suficiente.
4. **Environment → Environment Variables**:
   - `DATA_DIR` = `/data`
   - (No pongas `PORT`: Render lo inyecta y el servidor ya lo respeta.)
5. Crea el servicio y espera el deploy. Render te da una URL `https://...onrender.com`.

---

## Notas importantes (léelas)

- **Plan de pago para 24/7 + disco.** Los planes gratuitos de Render **se duermen**
  por inactividad (mataría los bots en ejecución) y **no** ofrecen disco persistente.
  Railway también consume créditos/uso. Para correr bots de forma continua y no
  perder datos, usa un plan de pago con volumen.
- **Sin login (por tu decisión).** El panel queda accesible para cualquiera que
  tenga la URL: podría ver y manejar todas las órdenes y, al editarlas, ver las
  contraseñas de tus clientes. Si algún día quieres, se le agrega una pantalla de
  acceso con usuario/contraseña.
- **Contraseñas en el volumen.** Se guardan en `DATA_DIR/orders.json` en texto
  plano. Mantén el repo y el servicio **privados**.
- **IP de datacenter.** El sitio `usvisa-info.com` puede mostrar más captchas o
  bloquear IPs de servidores en la nube (a diferencia de una IP residencial). Si
  ves muchos errores de login, esa suele ser la causa.
- **Licencia.** El proyecto usa PolyForm Noncommercial: el uso comercial (cobrar
  por el servicio) requiere permiso del autor. Tenlo presente.

---

## Actualizar el panel después

Cada vez que cambies el código:
```bash
git add -A && git commit -m "cambios" && git push
```
Railway/Render redepliegan solos. Como los datos están en el volumen (`/data`),
tus órdenes y logs **se conservan** entre despliegues.
