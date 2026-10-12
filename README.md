# 🤖 WhatsApp AI Assistant (Node.js + Flask & LangChain)

Assistant WhatsApp intelligent et sécurisé, propulsé par **LangChain**, **Groq (LLM)** et **whatsapp-web.js**. Ce projet intègre un frontend Node.js qui intercepte les messages WhatsApp et un backend Flask exécuté dans un Jupyter Notebook pour traiter et générer les réponses de l'IA.

---

## 🚀 Fonctionnalités

* **Sécurité & Contrôle d'accès** : Filtrage strict des messages basé sur une liste blanche de numéros autorisés (`ALLOWED_RAW_NUMBERS`).
* **Gestion des identifiants WhatsApp** : Support de la correspondance entre les formats `@c.us` et les identifiants récents `@lid`.
* **Backend IA Flexible** : Utilisation de LangChain et Groq pour des réponses textuelles rapides et pertinentes.
* **Environnement Jupyter** : Serveur Flask exécuté en arrière-plan avec gestion des boucles d'événements (`nest_asyncio`).

---

## 🛠️ Prérequis techniques

* **Node.js** (avec `whatsapp-web.js`, `axios`, `qrcode-terminal`)
* **Python 3.x** (Jupyter Notebook, Flask, LangChain Groq)
* **Google Chrome** (requis pour l'automatisation Puppeteer de WhatsApp Web)

---

## 📂 Structure du Projet

```text
whatsApp_agent/
├── index.js             # Script principal Node.js (Client WhatsApp)
├── requirements.txt     # Dépendances du backend Python
├── .gitignore           # Fichiers et dossiers ignorés par Git
└── README.md            # Documentation du projet
