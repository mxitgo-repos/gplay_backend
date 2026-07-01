# GPlay Backend — Cloud Functions

Backend de **Firebase Cloud Functions** para GPlay. Todo el código vive en un único archivo,
[`functions/index.js`](functions/index.js) (JavaScript, sin paso de build). Esta guía cubre la
instalación y el despliegue.

**Stack:** Node.js 22 · `firebase-functions` v7 · `firebase-admin` v13 · funciones de 1ª gen
(us-central1).

## Requisitos previos

- **Node.js 22** — el runtime de las functions está fijado a la versión 22
  (`functions/package.json` → `engines`); es la versión más reciente soportada por Cloud
  Functions for Firebase (Node 24 **no** está disponible para este tipo de despliegue). El
  repo incluye un [`.nvmrc`](.nvmrc), así que basta con `nvm use` en la raíz.

  Con [nvm](https://github.com/nvm-sh/nvm):

  ```bash
  nvm install 22   # solo la primera vez
  nvm use           # toma la versión de .nvmrc (verifica con: node -v  →  v22.x)
  ```

- **Firebase CLI**: `npm install -g firebase-tools`
- Acceso (rol de editor/owner) a los proyectos de Firebase de GPlay.

## Proyectos de Firebase

> ✅ **El alias `default` apunta a DEV** (`g-play-dd31d`), así que un `firebase deploy` sin
> `--project` despliega a DEV. Para desplegar a **PROD** hay que indicarlo explícitamente.
> Aun así, verifica el proyecto activo con `firebase use` antes de desplegar.

| Entorno | Alias            | Project name | Project ID         | Project number |
| ------- | ---------------- | ------------ | ------------------ | -------------- |
| **DEV** | `default`, `dev` | G-Play       | `g-play-dd31d`     | 547600257526 |
| **PROD**| `prod`           | G-Play-dev   | `g-play-dev-e4c4c` | 600941952664 |

Los tres alias están registrados en [`.firebaserc`](.firebaserc), por lo que puedes cambiar
de entorno por nombre (`firebase use dev` / `firebase use prod`).

## Instalación

```bash
# 1. Instalar dependencias
cd functions
npm install

# 2. Autenticarse en Firebase
firebase login
```

### Variables de entorno

Crea el archivo `functions/.env` manualmente (está en `.gitignore`, **no se versiona** y
**no debe contener secretos en commits**). Pide los valores al equipo o cópialos desde la
consola de Stripe / App Store Connect — usa los del proyecto correcto (los de DEV son `sk_test_…`,
los de PROD `sk_live_…`):

```dotenv
STRIPE_SECRET=
STRIPE_WEBHOOK_SECRET=
APPLE_SHARED_SECRET=
```

| Variable                | Uso                                                              |
| ----------------------- | --------------------------------------------------------------- |
| `STRIPE_SECRET`         | Clave secreta de Stripe (pagos, Connect, payouts).              |
| `STRIPE_WEBHOOK_SECRET` | Verifica la firma del webhook de Stripe (`stripeWebhook`).      |
| `APPLE_SHARED_SECRET`   | Validación de recibos de compras in-app de Apple.               |

## Verificar / cambiar el proyecto activo

```bash
firebase use          # muestra el proyecto activo
firebase use dev      # cambiar a DEV (g-play-dd31d) — es también el default
firebase use prod     # cambiar a PROD (g-play-dev-e4c4c)
```

## Probar en local (recomendado antes de desplegar)

```bash
firebase emulators:start --only functions   # levanta las functions localmente
firebase functions:shell                     # shell interactivo para invocarlas
```

## Deploy

> El deploy ejecuta `npm run lint` (ESLint) como hook de *predeploy*; si el lint falla, el
> deploy se aborta. Corre `npm run lint` antes para detectar errores.

```bash
# Todas las functions (al DEV, que es el default)
firebase deploy --only functions

# Una function específica
firebase deploy --only functions:nombreFuncion

# Desplegar a PROD (indícalo explícitamente)
firebase deploy --only functions --project prod
```

### Reglas de Firestore

`firebase.json` también enlaza [`firestore.rules`](firestore.rules). Para desplegar solo las
reglas:

```bash
firebase deploy --only firestore:rules
```

> ⚠️ Reconcilia primero con las reglas activas en la consola — un deploy de reglas las
> reemplaza por completo.

## Logs

```bash
firebase functions:log            # tail de logs (npm run logs)
```

## Verificar el despliegue (smoke tests)

No hay suite de tests unitarios. Para confirmar que las functions responden tras un deploy
hay una colección de Postman en
[`docs/gplay-dev.postman_collection.json`](docs/gplay-dev.postman_collection.json)
(solo peticiones **de lectura**). Impórtala en Postman (**Import** → selecciona el archivo).

- **`checkEmail`** es el mejor chequeo de salud: cualquier email devuelve un `200` limpio y
  ejercita `admin.auth()` + Firestore. Ejemplo con `curl`:

  ```bash
  curl -s -X POST https://us-central1-g-play-dd31d.cloudfunctions.net/checkEmail \
    -H "Content-Type: application/json" \
    -d '{"email":"test@example.com"}'
  # → {"exists":false,"existsInAuth":false,"existsInFirestore":false}
  ```

- Cambia la variable `baseUrl` de la colección a
  `https://us-central1-g-play-dev-e4c4c.cloudfunctions.net` para probar PROD.

## Solución de problemas (deploy)

- **`Cannot read properties of undefined (reading 'stdin')` en el predeploy** → npm 11 rompe
  el hook por defecto de Firebase. Ya está resuelto en [`firebase.json`](firebase.json)
  (`npm run lint --prefix …`). Usa Node 22 (`nvm use`) para deployar.
- **`nvm use` no cambia de versión** y avisa de `prefix`/`globalconfig` en `~/.npmrc` →
  quita esa clave: `npm config delete prefix --location=user` (y `globalconfig` si existe).
- **`npm ci ... ERESOLVE` / lockfile fuera de sync en Cloud Build** → Cloud Build corre
  `npm ci` de forma estricta. Regenera el lock con un `npm install` normal (sin `--omit=dev`)
  y valida en local con **`npm ci`** (no solo `--dry-run`) antes de deployar.
