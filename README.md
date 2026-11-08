# Arcadia 🎛️

Estudio musical multipista estilo BandLab, hecho por Abraham. Es una web que funciona como app (PWA): se instala desde Chrome con **⋮ → Agregar a pantalla de inicio**. Al final se empaquetará como APK con [Capacitor](https://capacitorjs.com).

**Abrir:** https://abrahamx87.github.io/Arcadia/

## Versión 0.2: primer avance grande
- **Biblioteca** estilo BandLab: Mis proyectos, Eliminados (papelera con restaurar), renombrar, duplicar
- **Studio negro puro** con pistas de colores: renombrar, cambiar color, tipo, subir/bajar, duplicar, eliminar
- **Audio real** (Web Audio API): reproducción multipista, formas de onda reales, zoom
- **Importar** MP3/WAV/M4A (varias pistas a la vez, detecta voz, coros, beat, bajo por el nombre)
- **Grabar** con el micrófono, con compensación de retraso
- **Editar regiones**: mover (toca y arrastra), dividir en el cursor, duplicar, renombrar, borrar
- **Mezclador**: volumen, paneo, mute, solo y volumen general
- **Efectos** por pista: Univerb, Exciter, Agudos, Ecualizador, Compresor, Delay, Limpiador
- **Presets**: Brillo + RV, Voz limpia, Voz trap, Sala grande y presets propios
- **Deshacer / rehacer**, metrónomo, tempo, ajuste a la cuadrícula
- **Exportar** la canción a WAV (descargar o compartir)
- Todo se guarda en el celular (IndexedDB), también sin internet

## Estructura
```
index.html         Pantallas e íconos
css/app.css        Tema negro puro
js/app.js          Interfaz: biblioteca, estudio, hojas
js/engine.js       Motor de audio: reproducir, grabar, exportar, demo
js/effects.js      Efectos y presets
js/store.js        Guardado local (IndexedDB)
sw.js              Funciona sin internet
```

## Siguiente
Sincronización con Abraham IA Music · recortar bordes de regiones · automatización · empaquetar APK
