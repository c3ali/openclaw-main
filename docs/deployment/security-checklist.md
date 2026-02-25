# Checklist de Sécurité - Déploiement Railway

Cette checklist couvre les mesures de sécurité essentielles pour déployer OpenClaw sur Railway.

## Avant le déploiement

### Secrets et credentials

- [ ] **Clés API** : Ne jamais commiter les clés API dans le code
- [ ] **Token gateway** : Générer un token sécurisé (`openssl rand -hex 32`)
- [ ] **Variables Railway** : Configurer toutes les secrets via les variables d'environnement Railway
- [ ] **Rotation** : Planifier la rotation régulière des tokens

### Code et configuration

- [ ] **Dépendances** : Vérifier les vulnérabilités (`pnpm audit`)
- [ ] **.dockerignore** : Exclure les fichiers sensibles (.env, .git, node_modules)
- [ ] **Branches** : Utiliser une branche dédiée au déploiement

## Configuration Railway

### Variables d'environnement obligatoires

| Variable | Sécurité | Notes |
|----------|----------|-------|
| `OPENCLAW_GATEWAY_TOKEN` | **Critique** | Token d'authentification gateway |
| `OPENAI_API_KEY` / `NANOGPT_API_KEY` | **Critique** | Clé API LLM |

### Variables d'environnement optionnelles

| Variable | Sécurité | Notes |
|----------|----------|-------|
| `TELEGRAM_BOT_TOKEN` | Élevée | Token bot Telegram |
| `DISCORD_BOT_TOKEN` | Élevée | Token bot Discord |
| `OPENCLAW_ALLOWED_ORIGINS` | Moyenne | Origines CORS autorisées |
| `LOG_LEVEL` | Basse | Niveau de logging |

### Configuration réseau Railway

- [ ] **Port** : Utiliser la variable `PORT` fournie par Railway
- [ ] **Health check** : Configurer `/health` comme endpoint de santé
- [ ] **Domaine personnalisé** : Configurer un domaine avec HTTPS

## Mesures de sécurité implémentées

### 1. Authentification Gateway

```javascript
// Token généré automatiquement ou via variable d'environnement
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || generateToken();
```

**Pourquoi** : Empêche l'accès non autorisé au gateway interne.

### 2. Proxy WebSocket sécurisé

```javascript
// Injection côté serveur du token (non visible par le client)
if (!msg.params.auth.token && gatewayToken) {
  msg.params.auth.token = gatewayToken;
}
```

**Pourquoi** : Le token n'est jamais exposé au navigateur client.

### 3. Trusted Proxies

```javascript
// Configuration automatique pour Railway
gateway.trustedProxies: ["127.0.0.1", "::1", "100.64.0.0/10"]
```

**Pourquoi** : Permet au gateway de faire confiance aux requêtes proxyées.

### 4. Utilisateur non-root

```dockerfile
# Le conteneur s'exécute avec l'utilisateur 'node'
USER node
```

**Pourquoi** : Réduit la surface d'attaque en cas de compromission.

## Après le déploiement

### Vérifications immédiates

- [ ] **Health check** : `curl https://votre-app.railway.app/health`
- [ ] **Logs** : Vérifier l'absence d'erreurs dans `railway logs`
- [ ] **Authentification** : Tester l'accès au Control UI

### Monitoring continu

- [ ] **Alertes Railway** : Configurer les notifications de déploiement
- [ ] **Logs** : Surveiller les tentatives d'accès non autorisées
- [ ] **Métriques** : Activer le monitoring Railway

### Maintenance

- [ ] **Mises à jour** : Maintenir les dépendances à jour
- [ ] **Rotation des tokens** : Planifier la rotation trimestrielle
- [ ] **Audit** : Revoir régulièrement les accès

## Risques et mitigations

| Risque | Mitigation |
|--------|------------|
| Fuite de clé API | Variables Railway + rotation |
| Accès non autorisé | Token gateway + trusted proxies |
| Injection de code | Validation des entrées + CSP |
| Élévation de privilèges | Utilisateur non-root |
| Interceptation | HTTPS obligatoire |

## En cas d'incident

### Fuite de clé API

1. **Immédiat** : Révoquer la clé auprès du provider
2. **Court terme** : Générer une nouvelle clé
3. **Moyen terme** : Mettre à jour la variable Railway
4. **Long terme** : Analyser les logs pour évaluer l'impact

### Compromission du conteneur

1. **Immédiat** : Arrêter le service Railway
2. **Court terme** : Redéployer depuis une image propre
3. **Moyen terme** : Faire une rotation de tous les secrets
4. **Long terme** : Analyser les logs et renforcer la sécurité

## Références

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Railway Security](https://docs.railway.app/deploy/security)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
