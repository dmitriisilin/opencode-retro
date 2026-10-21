<!-- translated-from: README.md@ffcdf40916ae -->
# opencode-retro

[English](README.md) | [Русский](README.ru.md) | [简体中文](README.zh-CN.md) | **Español** | [日本語](README.ja.md)

> Traducción de `README.md`. La versión en inglés es la canónica (canonical); si discrepan, prevalece ella.

Retrospectivas para agentes de programación. Un plugin de [OpenCode](https://opencode.ai) v2 que lee el diálogo de una sesión terminada, encuentra en él lo que puede mejorar el trabajo del agente y lo convierte en cambios propuestos al propio entorno del proyecto: sus skills, sus instrucciones, sus herramientas.

Un agente no aprende de sus propias sesiones. El único registro de dónde se atascó es el log, y los logs no se leen. Este plugin lee el log y vuelve con propuestas.

> Estado: completo y en funcionamiento, aún sin publicar. Verificado contra OpenCode 2.0.32. El paquete de npm sigue siendo un marcador de nombre, así que la instalación se hace desde una ruta.

## El problema

Los mismos obstáculos se repiten sesión tras sesión:

- Una skill indica ejecutar el linter. El proyecto no tiene ninguno. El agente lo ejecuta igualmente, reescribe cuarenta archivos, se da cuenta y lo revierte todo.
- Un archivo de instrucciones exige ejecutar la compilación antes de hacer commit. El proyecto no define ese script, así que el paso falla cada vez que se obedece.
- El estilo del código no está escrito en ninguna parte, de modo que cada sesión lo deduce de nuevo leyendo las fuentes.
- Un comando que falla se reintenta varias veces sin que nada cambie entre intentos.
- Una tarea del plan se abandona en silencio, como «ahora mismo no es posible».
- La misma corrección se da a mano por tercera semana consecutiva.

Todo está en el log. Nada de ello llega a la sesión siguiente.

## Cómo funciona

Dos bucles, deliberadamente separados. El primero se ejecuta solo y no consume atención. El segundo se ejecuta a petición y produce una decisión cada vez.

### Captura

Cada llamada a herramienta y cada prompt se añaden a un log paralelo en `.retro/sessions/<id>.jsonl`. No interviene ningún modelo: el plugin solo escribe. Por eso el log es independiente de la compactación del contexto; la trayectoria en bruto sobrevive a lo que la sesión haga con su propio historial.

### Extracción

Cuando una sesión termina, su log se conserva y no ocurre nada más hasta que se pide. El análisis cuesta una llamada al modelo, y nada en este plugin la gasta sin que se lo pidan.

`/retro` es el momento en que ocurre. Un solo comando comprime los logs acumulados, los convierte en lecciones y solo entonces busca algo que entregar. Un atraso largo se analiza de diez logs cada vez, para que un único comando no pueda facturar sin límite; lo que queda se informa, y otro `/retro` toma el siguiente lote.

Cada log se analiza en una sesión propia, creada para esa única llamada y eliminada después: entra el log, no intervienen agente, historial ni herramientas, y sale texto. El agente que hizo el trabajo queda excluido a propósito, porque defendería sus propias decisiones.

Solo se omite sin llamada la sesión que no puede contener evidencia de nada: una instrucción, una respuesta, nada hecho. Una conversación sin ninguna llamada a herramientas sí se analiza, porque es justo ahí donde se manifiesta un archivo de instrucciones equivocado: una respuesta errónea y una corrección, sin nada ejecutado.

`options.autoExtract` traslada el análisis al inicio de la sesión siguiente, para quien prefiera tener las lecciones listas antes de pedirlas.

Por omisión el análisis usa el modelo con el que se ejecutan tus propias sesiones y, si todavía no lo ha visto, el modelo por omisión del espacio de trabajo. Esto funciona también con los modelos de la capa gratuita de OpenCode, así que no hace falta configurar nada. `options.model` fija otro, lo que conviene si el análisis debe ejecutarse en algo más barato que el trabajo.

Esa llamada recibe una vista comprimida de la sesión: la salida de las herramientas se recorta y los prompts y las respuestas se conservan completos. Responde a una sola pregunta:

> Si esta sesión volviera a ejecutarse, ¿qué debería cambiar en el proyecto para que fuera más corta y más recta?

La respuesta es una lista de lecciones en `.retro/lessons/`.

Un log cuesta como máximo una llamada. Un proyecto en el que nunca se revisa no se analiza nunca.

### Qué guía la extracción

Los criterios no están compilados en el plugin. Residen en [`prompts/extract.md`](prompts/extract.md), que se siembra en el proyecto como `.retro/prompts/extract.md` y se edita allí. Describen las formas que vale la pena buscar:

- Trabajo hecho en balde: la misma llamada repetida sin que ningún archivo haya cambiado entre intentos.
- Una edición hecha y luego deshecha, ya sea por una edición posterior o al descartar el árbol de trabajo.
- Una skill seguida hasta un callejón sin salida, cuando un comando que la skill prescribía falló después.
- Un fallo que no parece un fallo: un código de salida distinto de cero detrás de un estado que dice «completed».
- Una tarea abandonada en silencio, visible solo en lo que el agente escribió.
- Una corrección que el usuario tuvo que dar más de una vez.

El propio archivo indica que esto es un punto de partida y no una lista de verificación.

### Revisión

El plugin lee el log. La persona lee propuestas. El plugin se detiene en la propuesta y no edita los archivos del proyecto.

| Comando | Qué hace |
|---|---|
| `/retro` | Analiza lo acumulado y entrega después una lección: la de mayor puntuación aún sin decidir. |
| `/retro all` | El mismo análisis y después todas las lecciones pendientes como un único plan, para aprobarlo de una pasada. |

No hay un tercer comando. Si el plugin funciona se informa en `.retro/selfcheck.md`, reescrito en cada revisión.

La lección se entrega en la sesión donde se ejecutó el comando, dirigida al agente que ya está allí. Primero se le pide que determine si la lección sigue siendo válida, después que la transmita, y que no cambie nada hasta que haya una decisión.

```
# retro — lint-skill-no-config

La skill lint prescribe `npx eslint . --fix`, que este proyecto no puede ejecutar.

Vista en 2 sesiones, 9 pasos gastados en ella, confianza 0.9, puntuación 16.2.
Vista por última vez hace 3 sesiones.

Cambio propuesto
  AGENTS.md — condicionar el requisito de lint a que exista una configuración de ESLint
  en el repositorio.

Requiere una decisión
  ¿Debería este proyecto tener ESLint configurado, o conviene abandonar la convención?
```

La decisión corresponde a la persona y al agente de esa sesión. El agente tiene los archivos, el historial y las skills propias del proyecto, lo que lo convierte en mejor juez de si una lección sigue aplicándose que el plugin. Una vez tomada la decisión, el agente la registra mediante una herramienta `retro_decide`. Esa herramienta solo lleva la contabilidad: un rechazo se recuerda y la lección no se vuelve a proponer.

`/retro all` es la misma entrega para todo a la vez. Las lecciones pendientes se ordenan, las que siguen en pie se reúnen en un único plan agrupado por archivo, y el plan se aprueba una sola vez.

### Dónde corresponde el arreglo

Una lección registra un problema. Dónde arreglarlo se decide durante la entrega, entre el agente y la persona, después de mirar lo que el espacio de trabajo tiene realmente: qué archivos de instrucciones lee el entorno aquí, si existen skills a nivel de proyecto o globales, si hay algo más específico que ya cubra la tarea.

Las opciones:

- Modificar un archivo de instrucciones, para un hecho o una restricción de alcance amplio.
- Modificar una skill, cuando una skill dio los pasos equivocados o se activó donde no debía.
- Crear una skill, o un archivo de instrucciones limitado al directorio donde la regla se aplica, cuando el sitio adecuado todavía no existe.
- Pedir una herramienta, cuando lo que falta es una capacidad y no una instrucción.
- Cambiar el código del proyecto, cuando la trampa está en el código. Nunca se aplica sin acuerdo explícito.
- Dejarlo sin ubicar, cuando el sitio correcto no está realmente claro.

Las lecciones en sí son siempre locales a un espacio de trabajo. El arreglo puede no serlo: si la causa está en cómo trabaja una persona en todas partes, el arreglo pertenece a su entorno global, porque arreglarla en un proyecto la deja rota en los demás. Nada fuera del proyecto se edita sin preguntar.

El procedimiento y esta lista están en [`prompts/review.md`](prompts/review.md), que se siembra en el proyecto y se puede editar allí.

## Lecciones

Una lección es un archivo Markdown con frontmatter YAML.

```yaml
id: lint-skill-no-config
statement: The lint skill assumes eslint; this project has no linter.
evidence:
  - session: a81f
    steps: [41, 58]
  - session: c204
    steps: [12, 19]
cost: 34
recurrence: 3
confidence: 0.9
lastSeen: 41
recordedAt: 2026-10-19T15:16:04.134Z
proposal:
  target: .opencode/skills/lint/SKILL.md
  change: |
    Before running, check for a lint config and a lint script.
    If absent, do not run; report instead.
ask: Is the linter really unused here?
status: new
```

`cost` es el número de pasos que el problema consumió, sumados entre sesiones. `recurrence` es el número de sesiones independientes en las que apareció. `lastSeen` es el contador de sesiones del espacio de trabajo en su aparición más reciente.

### Ordenación

La puntuación es `cost × recurrence × confidence × freshness`.

La frescura se reduce a la mitad cada diez sesiones en las que el problema no ha aparecido, contadas en sesiones y no en días. A razón de una sesión diaria, un decaimiento medido por el calendario lo enterraría todo de un día para otro.

La recurrencia pesa más que un único incidente caro. Un problema visto en tres sesiones se verá en una cuarta.

### Ciclo de vida

Una lección se indexa por problema, no por sesión. Una segunda sesión que choca con lo mismo añade su evidencia e incrementa `recurrence` en lugar de crear otro archivo.

En `lessons/` solo hay cuestiones abiertas. Una decisión mueve el archivo a `archive/`, y nada se borra nunca. Un problema que vuelve después de haberse cerrado es el mismo problema más la noticia de que el arreglo no se sostuvo, así que se reabre con su historial intacto. Un límite, treinta por omisión, mantiene la lista corta; lo que desborda también se archiva.

## Instalación

El paquete de npm es por ahora un marcador de nombre, así que `opencode.json` debe apuntar a una copia local. La ruta tiene que ser absoluta; una relativa deja el arranque de la sesión colgado sin dar ningún error.

```jsonc
{
  "plugins": [
    {
      "package": "/abs/path/to/opencode-retro",
      "options": {
        "model": { "providerID": "deepseek", "id": "deepseek-flash" }
      }
    }
  ]
}
```

`options.model` es opcional. Sin él, el plugin usa el modelo con el que se ejecutan tus sesiones y, si todavía no lo ha visto, recurre al modelo por omisión del espacio de trabajo. `.retro/selfcheck.md` informa de qué modelo se usó y de dónde salió.

Todo lo demás es opcional:

- `dir` — dónde vive todo, por omisión `.retro`.
- `prompts` — el directorio de prompts, por omisión `prompts` dentro de él.
- `halfLife` — sesiones sin recurrencia antes de que la puntuación de una lección se reduzca a la mitad, por omisión diez.
- `autoLimit` — lecciones en un `/retro all`, por omisión diez.
- `extractLimit` — logs que analiza un `/retro`, sin límite por omisión.
- `maxOutput` — caracteres de salida de herramienta que se guardan por paso, por omisión 8000.
- `extractTimeoutMs` — cuánto puede tardar un análisis antes de abandonarlo, por omisión 90000.
- `heartbeatMs` — el intervalo mínimo entre escrituras de la autocomprobación mientras una sesión trabaja, por omisión 60000.
- `keepSessions` — conservar todos los logs, incluidos los que nadie cita.
- `autoExtract` — analizar al inicio de la sesión siguiente en vez de esperar a que se pida.

### Qué aparece en disco

Todo lo que el plugin escribe se queda bajo `.retro/` dentro del proyecto, y en ningún otro sitio salvo que se acepte una propuesta. Todo es texto plano.

```
.retro/
  prompts/
    extract.md       qué cuenta como lección
    review.md        cómo se entrega una lección
    review-auto.md   cómo un lote se convierte en un plan
  sessions/          logs en bruto, se borran tras la extracción
  lessons/           cuestiones abiertas
  archive/           lecciones decididas y desalojadas
  selfcheck.md       si el plugin funciona
  state.json
```

Un log permanece en disco mientras alguna lección abierta lo cite. La evidencia de una lección nombra una sesión y un rango de pasos, y durante la revisión la pregunta «¿qué pasó realmente ahí?» tiene que tener una respuesta que no sea un resumen. Cuando todas las lecciones que citan un log han sido decididas, el log se elimina. El crecimiento lo marca el número de lecciones abiertas, que está acotado, y no la edad del proyecto.

No hay nada que añadir al `.gitignore` del proyecto. En la primera ejecución el plugin escribe `.retro/.gitignore`, y git lo aplica a todo lo que hay debajo: las sesiones, el estado, la autocomprobación y el log del plugin quedan ignorados, mientras que `lessons/`, `archive/` y los prompts no. Ese archivo se siembra una vez y a partir de entonces es del proyecto.

La separación es el diseño, no una comodidad. Las lecciones y el archivo son conocimiento sobre el proyecto: se leen, aparecen en la revisión y viajan con el repositorio. Los prompts son su configuración, que conviene compartir con quien más trabaje aquí. El resto solo haría ruido en un diff.

### Prompts

Tres prompts determinan lo que hace el plugin, y los tres son archivos dentro del proyecto: qué cuenta como lección, cómo se entrega una lección y cómo un lote de lecciones se convierte en un plan.

Cada uno se siembra desde el valor por omisión del paquete en la primera ejecución y no se vuelve a escribir. La resolución va primero por el proyecto, después por `~/.config/opencode/retro/prompts/` y por último por el valor del paquete, de modo que un prompt puede fijarse para un proyecto, para todos o para ninguno.

Cuando se publica un valor por omisión más nuevo, aparece como `prompts/updates/<name>.vN.md`, con una nota al principio que advierte de que ese archivo no está en uso. Nada se aplica en nombre del usuario.

Lo que permanece en el código es la maquinaria: el formato de salida que requiere el analizador, el orden de los campos de una lección y la instrucción de registrar la decisión. El formato de salida no se escribe nunca en disco, y por eso editar un prompt no puede romper el análisis.

## Comprobar que funciona

Que un hook se registre no demuestra nada. Un hook registrado con un nombre que la API ya no usa se registra con éxito y luego no se dispara nunca.

Por eso `.retro/selfcheck.md` informa de que está vivo, no de que está instalado: compara lo que vio el flujo de eventos con lo que recibieron los hooks. El archivo lleva su propia regla de caducidad:

> Si hay trabajo en curso y `heartbeat` tiene más de unos pocos minutos, el plugin no está en marcha.

Esas comprobaciones se ejecutan en cada revisión y no cuestan nada: las versiones del plugin y de OpenCode, la superficie de API de la que el plugin depende, qué capa de prompts está vigente y qué hay esperando. Si el modelo responde y si el formato de salida sigue siendo analizable no se preguntan por separado: cada `/retro` ejercita ambas cosas e informa con las palabras del propio modelo cuando alguna falla.

## Requisitos

- OpenCode v2, `@opencode/plugin` 2.0 o posterior. Verificado contra 2.0.32.
- Nada más allá de OpenCode. El análisis usa por omisión tu propio modelo; uno económico es suficiente.
- Ninguna dependencia en tiempo de ejecución.

## Licencia

MIT
