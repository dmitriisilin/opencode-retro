<!-- translated-from: README.md@c992cf40fece -->
# opencode-retro

[English](README.md) · [Русский](README.ru.md) · [简体中文](README.zh-CN.md) · **Español** · [日本語](README.ja.md)

> Traducción de `README.md`. La versión en inglés es la canónica (canonical); si discrepan, manda ella.

**Retrospectivas para agentes de programación.** Un plugin de [OpenCode](https://opencode.ai) v2 que convierte la fricción de una sesión —reversiones, bucles, tareas abandonadas, correcciones del usuario— en cambios propuestos a tu entorno de trabajo: skills, instrucciones, herramientas, código.

Los agentes no aprenden de sus propias sesiones. La única forma de saber dónde se atascaron es leer el log, y el log nadie lo lee. `opencode-retro` lo lee por ti y vuelve con propuestas.

> **Estado: funciona de principio a fin, aún sin publicar.** Captura, extracción y revisión están construidas y verificadas contra OpenCode 2.0.32. En npm solo hay un marcador de nombre: por ahora se instala desde una ruta. Lo que hay y lo que no, en la [hoja de ruta](#hoja-de-ruta).

## El problema

En cada sesión, un agente se da contra las mismas paredes:

- una skill dice «ejecuta el linter» y el proyecto no usa ninguno; el agente lo ejecuta, reescribe 40 archivos, se da cuenta del error y lo revierte todo;
- el mismo comando fallido se reintenta cuatro veces sin que nada cambie entre intentos;
- una tarea del plan se abandona en silencio como «ahora mismo no es posible»;
- el usuario dice «no, aquí no lo hacemos así» por tercera semana consecutiva;
- una herramienta que habría ahorrado 20 pasos simplemente no está.

Todo eso está en el log. Nada de eso llega a la sesión siguiente.

## Qué hace

Dos bucles, deliberadamente separados.

### 1. Bucle de captura — automático, en cada sesión

El plugin mantiene un **log paralelo** ligero de cada llamada a herramienta y cada prompt (`.retro/sessions/<id>.jsonl`). Sin modelo de lenguaje, solo escrituras al final. Eso hace que el plugin no dependa de la compactación del historial: la trayectoria en bruto siempre está disponible. Una vez extraída una sesión, su log se borra: la historia ya la lleva la propia lección, y guardar un log por sesión para siempre es acumular.

No hay detectores delante del modelo ni reglas sobre qué cuenta como fricción. Probamos tres —un comando repetido sin que nada cambiara entre intentos, una edición deshecha, una skill cuyo comando prescrito falló— y **medimos** si cambiaban el resultado. No lo cambiaban: con el mismo log, el modelo encontró las mismas lecciones con ellos y sin ellos (`fixtures/ab-anchors/`). Lo que en realidad codificaban no era detección, sino una opinión sobre qué mirar, y una opinión va en un prompt que puedes leer y discutir, no en código que decide de antemano qué le está permitido notar al modelo. Así que ahí está: `.retro/prompts/extract.md` describe las formas que vale la pena buscar —trabajo repetido para nada, una edición deshecha, una skill seguida hasta un callejón sin salida, un código de salida distinto de cero escondido detrás de un estado «completed», una tarea abandonada en silencio, una corrección que tuviste que hacer dos veces— y dice explícitamente que es un punto de partida y no una lista de verificación.

Cuando una sesión termina queda en cola, y **el primer prompt de la sesión siguiente** paga esa deuda: una llamada al modelo con contexto limpio (no el agente que trabajó: defendería sus propias decisiones) recibe una proyección comprimida del log, con las salidas de herramientas recortadas y los prompts y respuestas completos. Responde a una sola pregunta:

> *Si esta sesión volviera a ejecutarse, ¿qué debería cambiar para que fuera más corta y más recta?*

El resultado es una lista de **lecciones** en `.retro/lessons/`.

Por qué la sesión siguiente y no esta: `generate.text` de OpenCode solo se resuelve cuando la llamada parte de dentro de un hook, y una sesión termina con un evento. Así que las lecciones llegan con una sesión de retraso, y un proyecto que no vuelves a abrir no cuesta nada. `/retro` liquida la deuda cuando se lo pides.

### 2. Bucle de integración — a demanda, `/retro`

El plugin lee el log. Tú lees propuestas. Se detiene en la propuesta: no toca tus archivos.

```
/retro         una lección — la de mayor puntuación aún sin decidir
/retro auto    todas las lecciones pendientes, como un único plan que apruebas de una vez
/retro check   si el plugin está funcionando de verdad
```

`/retro` entrega la lección en la sesión desde la que lo ejecutaste, como un mensaje dirigido al agente que ya está ahí:

```
_opencode-retro: primero responde a una pregunta — ¿esto ya está resuelto en este espacio
de trabajo tal como está ahora? Una lección puede llevar semanas ahí, y tú conoces este
proyecto; compruébalo como lo harías normalmente. … no cambies nada hasta que la persona
haya decidido._

# retro — `lint-skill-no-config`

La skill lint prescribe `npx eslint . --fix`, que este proyecto no puede ejecutar.

Vista en 2 sesiones, 9 pasos gastados en ella, confianza 0.9 → puntuación 16.2.
Vista por última vez hace 3 sesiones.

_Conviene saber antes de comprobar: registrada el 2026-10-19; `AGENTS.md` ha cambiado desde
entonces._

## Cambio propuesto
**AGENTS.md** — hacer que el requisito de lint dependa de que haya una configuración de
ESLint en el repositorio.

## Necesita tu decisión
¿Este proyecto debería tener ESLint configurado, o hay que abandonar la convención de lint?
```

A partir de ahí decidís tú y el agente. El agente tiene los archivos, el historial y las skills propias de este proyecto; juzga mejor que el plugin si la lección sigue en pie y, en la práctica, comprueba las afirmaciones y encuentra consecuencias que la propuesta no había visto. Cuando has decidido, registra el resultado con una herramienta `retro_decide` — pura contabilidad. Un rechazo se recuerda, de modo que la lección no se vuelve a proponer.

`/retro auto` es lo mismo para todo a la vez: todas las lecciones pendientes, ordenadas, con un único plan que cubre las que siguen en pie, agrupadas por archivo. Pensado para el modo plan: lees el plan, apruebas una vez, adelante.

La propuesta de una lección es una *sugerencia*, no un esquema. Destinos habituales:

- **skill** — corregir o ampliar un `SKILL.md` con cómo se hace realmente la tarea aquí
- **instruction** — un hecho o una restricción para `AGENTS.md`
- **tool** — una petición a la persona: «falta X; sin ello las sesiones A, B y C perdieron unos N pasos cada una»
- **refactor** — un cambio en el código que elimina la trampa, con su justificación, nunca aplicado de forma automática
- **other** — no encaja; decide la persona

## Formato de una lección

```yaml
id: lint-skill-no-config
statement: The `lint` skill assumes eslint; this project has no linter.
evidence:
  - session: a81f
    steps: [41, 58]
  - session: c204
    steps: [12, 19]
cost: 34          # pasos consumidos por el problema, sumados entre sesiones
recurrence: 3     # sesiones independientes en las que apareció
confidence: 0.9
lastSeen: 41      # el contador de sesiones del espacio cuando apareció por última vez
recordedAt: 2026-10-19T15:16:04.134Z
proposal:         # opcional
  target: .opencode/skills/lint/SKILL.md
  change: |
    Before running: check for a lint config (eslint.config.*, .eslintrc*)
    and a `lint` script in package.json. If absent, do not run; report.
ask: Is the linter really unused here? Remove the skill from this project?
status: new       # new | later   (las decididas pasan a archive/)
```

La puntuación es `cost × recurrence × confidence × freshness`, donde la frescura se reduce a la mitad cada diez sesiones en las que el problema no ha aparecido — contadas en **sesiones, no en días**, porque a una sesión por día un decaimiento por reloj lo enterraría todo de un día para otro. La recurrencia importa más que un único incidente caro: una lección que aparece en tres sesiones *va a* aparecer en la cuarta.

Las lecciones tienen como ámbito el espacio de trabajo y se indexan por problema, no por sesión: una segunda sesión que choca con lo mismo añade evidencia e incrementa `recurrence` en lugar de crear un segundo archivo. En `lessons/` solo hay cuestiones abiertas — decidir mueve el archivo a `archive/`, y nada se borra nunca, porque un problema que vuelve después de haber sido cerrado es el mismo problema **más** la noticia de que el arreglo no aguantó. Vuelve con su historial intacto. Un límite (30 por defecto) mantiene la lista corta; lo que sobra también se archiva.

## Lo que no es

- **No es un plugin de memoria.** Los plugins de memoria construyen una base de conocimiento que el agente tiene que acordarse de consultar. `opencode-retro` edita los artefactos que el entorno ya lee (`SKILL.md`, `AGENTS.md`). El conocimiento que vive en una skill no hace falta recordarlo.
- **No es un rompedor de bucles.** Los detectores de bucles paran al agente *ahora*. Este plugin se encarga de que el bucle no ocurra *la próxima vez*. Usa los dos.
- **No es un recolector de caminos de éxito.** La mayoría de las herramientas de skills que se mejoran a sí mismas capturan lo que *funcionó*. Esta captura lo que *no funcionó*, que es donde están las victorias baratas.

## Lección local, arreglo local o global

Las lecciones son siempre locales al espacio de trabajo. Una lección es evidencia de sesiones de un solo proyecto, así que vive en ese proyecto y en ningún otro sitio: no hay almacén global de lecciones ni promoción de lecciones entre proyectos. Es así a propósito.

Lo que puede ser global es el **arreglo**. Parte de la fricción es sobre este repositorio: una skill que no encaja con él, una afirmación de `AGENTS.md` que aquí no es cierta. Parte es sobre cómo trabajas en todas partes: cómo tratas con tu gestor de incidencias, cómo quieres que se llamen las ramas, una convención que llevas contigo entre proyectos. Lo primero pertenece al entorno del proyecto; lo segundo, al tuyo global: `~/.config/opencode/AGENTS.md`, o una skill global.

Cuál de las dos pide una lección se decide en el momento de entregarla, entre tú y el agente, mirando lo que la lección dice de verdad. El plugin no lo adivina, y nunca edita tu entorno global por su cuenta.

## Hoja de ruta

| Nivel | Qué hace el plugin | Qué hace la persona | |
|---|---|---|---|
| **L0** | captura + extrae lecciones | lee `lessons/` a mano | ✅ |
| **L1** | `/retro` propone, de una en una | decide, junto con el agente | ✅ |
| **L1.5** | `/retro auto` planifica todo lo pendiente | aprueba el plan una vez | ✅ |
| **L2** | las lecciones de alta confianza confirmadas ≥2 veces se aplican a una rama automáticamente | revisa el lote | |
| **L3** | skills e instrucciones se aplican sin revisión | solo ve las peticiones `tool` y `refactor` | |

El ascenso entre niveles lo dirigen las propias estadísticas de aceptación y rechazo del plugin: la autonomía se la gana, no se le concede.

Aún sin construir: los niveles de arriba.

## Decisiones de diseño

- **Sesión de extracción aparte.** El agente que trabajó es el peor juez de su propia sesión.
- **Log paralelo, no historial de sesión.** La compactación no puede comerse lo que ya escribimos.
- **La fricción antes que el éxito.** Las reversiones, las repeticiones y las correcciones son más raras y dicen más que «esto fue bien».
- **Artefactos antes que memoria.** Cambia lo que el entorno ya lee; no añadas algo que haya que recordar.
- **Primero la persona.** La autonomía es un nivel posterior con su propia carga de prueba.
- **Pararse en la propuesta.** El agente de tu sesión tiene los archivos, el historial y las skills de este proyecto. Preguntarle *«¿esto sigue siendo cierto?»* es mejor que que el plugin prescriba cómo comprobarlo.

## Instalación

En npm todavía no hay más que un marcador de nombre. Apunta `opencode.json` a una copia local — la ruta tiene que ser **absoluta**; una relativa cuelga el arranque de la sesión sin dar ningún error:

```jsonc
{
  "plugins": [
    {
      "package": "/abs/path/to/opencode-retro",
      "options": {
        // obligatorio: sin esto OpenCode resuelve su capa gratuita, que un plugin no puede usar
        "model": { "providerID": "deepseek", "id": "deepseek-flash" }
      }
    }
  ]
}
```

El resto de opciones, todas opcionales: `dir` (por defecto `.retro`), `prompts`, `halfLife` (10 sesiones), `autoLimit` (10 lecciones por `/retro auto`), `maxOutput`, `extractTimeoutMs`, `keepSessions`.

Todo lo que el plugin escribe va bajo `.retro/` en tu proyecto, y a ningún otro sitio salvo que aceptes una propuesta. Todo es texto plano:

```
.retro/
├── prompts/
│   ├── extract.md       # tuyo para editar — qué cuenta como lección
│   ├── review.md        # tuyo para editar — cómo se entrega una lección
│   └── review-auto.md   # tuyo para editar — cómo un lote se vuelve un plan
├── sessions/<id>.jsonl  # material en bruto, se borra tras la extracción
├── lessons/<id>.md      # el producto
├── archive/             # lecciones decididas y desalojadas
├── selfcheck.md         # si el plugin funciona
└── state.json
```

Cada prompt se siembra desde el valor por defecto del paquete en la primera ejecución y no se vuelve a escribir nunca. La resolución es proyecto → `~/.config/opencode/retro/prompts/` → paquete, así que puedes fijar uno para un proyecto, para todos tus proyectos, o para ninguno. Un valor por defecto más nuevo llega como `prompts/updates/<name>.vN.md`, encabezado por una nota que avisa de que ese archivo no está en uso: nada se aplica en tu nombre.

Lo que se queda en el código y no es tuyo para editar es la maquinaria: el formato de salida que necesita el analizador (`/retro check` lo imprime), el orden de los campos de una lección y la instrucción de registrar el resultado. Un prompt que deja de producir lecciones analizables falla en silencio, y ese es el único modo de fallo contra el que vale la pena diseñar.

### ¿Está funcionando?

Que un hook se registre no prueba nada: un nombre de hook equivocado se registra encantado y no se dispara jamás. Así que `.retro/selfcheck.md` no afirma que esté instalado, sino que está vivo — cruzando el flujo de eventos con los hooks — y lleva su propia regla de caducidad:

> Si estás trabajando ahora mismo y `heartbeat` tiene más de unos pocos minutos, este plugin
> no está en marcha.

`/retro check` es la versión activa: la superficie de `ctx`, la conectividad con el modelo, qué capa de prompts está vigente, y una ida y vuelta del contrato de salida real.

## Requisitos

- OpenCode **v2** (`@opencode/plugin` ≥ 2.0; verificado contra 2.0.32)
- un modelo para la extracción, nombrado explícitamente en `options.model`; uno barato sirve
- ninguna dependencia en tiempo de ejecución

## Licencia

MIT
