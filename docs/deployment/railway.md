# Déploiement OpenClaw sur Railway

Ce guide explique comment déployer OpenClaw de manière sécurisée sur Railway.

## Prérequis

- Un compte Railway (https://railway.app)
- Un fork du repository OpenClaw
- Une clé API LLM (OpenAI, NanoGPT, OpenRouter, etc.)

## Architecture de déploiement

```
┌─────────────────────────────────────────────────────────────┐
│                      Railway Container                       │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                    src/server.js                         ││
│  │  - Express server (port 8080)                           ││
│  │  - Page de configuration (/setup)                       ││
│  │  - Proxy WebSocket avec injection de token              ││
│  │  - Health checks (/health)                              ││
│  └────────────────────┬────────────────────────────────────┘│
│                       │                                      │
│  ┌────────────────────▼────────────────────────────────────┐│
│  │              OpenClaw Gateway (port 18789)              ││
│  │  - Traitement des messages                              ││
│  │  - Communication avec les providers LLM                 ││
│  │  - Gestion des canaux (Telegram, Discord, etc.)         ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## Déploiement rapide

### 1. Fork et configuration

```bash
# Fork le repository OpenClaw sur GitHub
# Puis cloner votre fork
git clone https://github.com/VOTRE_USER/openclaw.git
cd openclaw

# Créer la branche de déploiement
git checkout -b railway-deploy
```

### 2. Déployer sur Railway

1. Connectez-vous à [Railway](https://railway.app)
2. Cliquez sur "New Project" → "Deploy from GitHub repo"
3. Sélectionnez votre fork OpenClaw
4. Railway détectera automatiquement la configuration via `railway.json`

### 3. Configurer les variables d'environnement

Dans Railway, ajoutez ces variables :

| Variable | Description | Obligatoire |
|----------|-------------|-------------|
| `OPENCLAW_GATEWAY_TOKEN` | Token d'authentification gateway | Recommandé |
| `OPENAI_API_KEY` | Clé API OpenAI | Ou autre provider |
| `NANOGPT_API_KEY` | Clé API NanoGPT | Alternative |
| `TELEGRAM_BOT_TOKEN` | Token bot Telegram | Optionnel |
| `DISCORD_BOT_TOKEN` | Token bot Discord | Optionnel |

## Configuration sécurisée

### Variables d'environnement sensibles

Ne stockez **jamais** les clés API dans le code. Utilisez les variables Railway :

```bash
# Via Railway CLI
railway variables set OPENAI_API_KEY=sk-xxxxx
railway variables set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)
```

### Token gateway pré-généré

Pour plus de sécurité, générez le token gateway avant le déploiement :

```bash
# Générer un token sécurisé
openssl rand -hex 32 > /tmp/gateway-token.txt

# Définir dans Railway
railway variables set OPENCLAW_GATEWAY_TOKEN="$(cat /tmp/gateway-token.txt)"
```

### Configuration du provider LLM

Vous pouvez pré-configurer le provider via les variables d'environnement :

**Option 1 : OpenAI officiel**
```
OPENAI_API_KEY=sk-xxxxx
```

**Option 2 : NanoGPT (OpenAI + Anthropic)**
```
NANOGPT_API_KEY=xxxxx
OPENAI_BASE_URL=https://nano-gpt.com/api/v1
```

**Option 3 : OpenRouter**
```
OPENROUTER_API_KEY=sk-or-xxxxx
```

## Sécurité

### Mesures implémentées

1. **Authentification gateway** : Token cryptographique généré automatiquement
2. **Proxy sécurisé** : Injection de token côté serveur (non exposé au client)
3. **Trusted proxies** : Configuration automatique pour le réseau Railway
4. **Non-root** : Le conteneur s'exécute avec l'utilisateur `node`

### Configuration réseau

Le serveur configure automatiquement :
- `gateway.trustedProxies` : `["127.0.0.1", "::1", "100.64.0.0/10"]`
- `gateway.controlUi.allowedOrigins` : `["*"]` (à restreindre en production)

### Recommandations production

1. **Restreindre les origines** :
   ```bash
   railway variables set OPENCLAW_ALLOWED_ORIGINS='["https://votre-domaine.com"]'
   ```

2. **Utiliser un domaine personnalisé** avec HTTPS

3. **Activer les logs** :
   ```bash
   railway variables set LOG_LEVEL=info
   ```

## Flux d'authentification

```
┌──────────┐     ┌──────────────┐     ┌─────────────────┐
│  Client  │────▶│  src/server  │────▶│  OpenClaw       │
│  Browser │     │  (Proxy)     │     │  Gateway        │
└──────────┘     └──────────────┘     └─────────────────┘
      │                │                      │
      │   WebSocket    │   Token injecté     │
      │   connect ────▶│   dans message ────▶│
      │                │   (non visible)      │
      │                │                      │
      │◀───────────────│◀─────────────────────│
      │   Réponse      │   Réponse           │
```

## Dépannage

### Le conteneur ne démarre pas

Vérifiez les logs :
```bash
railway logs
```

### Erreur "Gateway not ready"

1. Vérifiez que le port 18789 est disponible
2. Attendez 30 secondes après le démarrage
3. Vérifiez les logs pour les erreurs de configuration

### WebSocket déconnecté

1. Vérifiez que le token gateway est configuré
2. Vérifiez les headers `Origin` dans les requêtes
3. Consultez `/tmp/server.log` dans le conteneur

## Monitoring

### Health check

```bash
curl https://votre-app.railway.app/health
```

Réponse attendue :
```json
{
  "status": "healthy",
  "configured": true
}
```

### Logs

Les logs sont disponibles via :
```bash
railway logs --tail
```

## Ressources

- [Documentation OpenClaw](https://docs.openclaw.ai)
- [Railway Documentation](https://docs.railway.app)
- [Security Checklist](./security-checklist.md)
