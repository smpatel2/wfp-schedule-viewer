/**
 * Service Worker for WFP On-Call Schedule Viewer
 *
 * Caches the app shell for offline access.
 * Schedule data caching is handled by Firestore's persistentLocalCache.
 */

const CACHE_NAME = 'wfp-schedule-v3';

const APP_SHELL = [
    '/',
    '/index.html',
    '/css/styles.css',
    '/js/app.js',
    '/js/firebase-init.js',
    '/firebase-config.js',
    '/manifest.json',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
];

const CDN_RESOURCES = [
    'https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js',
    'https://cdn.jsdelivr.net/npm/fullcalendar@6.1.15/index.global.min.css',
    'https://cdn.jsdelivr.net/npm/fullcalendar@6.1.15/index.global.min.js',
];

// Install: cache app shell + CDN resources
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll([...APP_SHELL, ...CDN_RESOURCES]);
        })
    );
    self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

// Fetch: Network-first for app shell, cache-first for CDN
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Don't intercept Firestore/Firebase API calls
    if (url.hostname.includes('googleapis.com') ||
        url.hostname.includes('firebaseio.com') ||
        url.hostname.includes('firebaseinstallations') ||
        url.hostname.includes('identitytoolkit')) {
        return;
    }

    // CDN resources: cache-first (versioned URLs don't change)
    if (url.hostname.includes('cdn.jsdelivr.net') ||
        url.hostname.includes('fonts.googleapis.com') ||
        url.hostname.includes('fonts.gstatic.com')) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                return cached || fetch(event.request).then((response) => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    return response;
                });
            })
        );
        return;
    }

    // App shell: network-first for rapid updates
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
