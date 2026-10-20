<!-- translated-from: README.md@d979c2513836 -->
# opencode-retro

[English](README.md) | [Русский](README.ru.md) | [简体中文](README.zh-CN.md) | **Español** | [日本語](README.ja.md)

> Traducción de `README.md`. La versión en inglés es la canónica (canonical); si discrepan, prevalece ella.

Retrospectivas para agentes de programación. Un plugin de [OpenCode](https://opencode.ai) v2 que convierte la fricción de una sesión en cambios propuestos al propio entorno del proyecto: sus skills, sus instrucciones, sus herramientas.

Un agente no aprende de sus propias sesiones. El único registro de dónde se atascó es el log, y los logs no se leen. Este plugin lee el log y vuelve con propuestas.

> Estado: completo y en funcionamiento, aún sin publicar. Verificado contra OpenCode 2.0.32. El paquete de npm sigue siendo un marcador de nombre, así que la instalación se hace desde una ruta.

## El problema

Los mismos obstáculos se repiten sesión tras sesión:

- Una skill indica ejecutar el linter. El proyecto no tiene ninguno. El agente lo ejecuta igualmente, reescribe cuarenta archivos, se da cuenta y lo revierte todo.
- Un comando que falla se reintenta varias veces sin que nada cambie entre intentos.
- Una tarea del plan se abandona en silencio, como «ahora mismo no es posible».
- La misma corrección se da a mano por tercera semana consecutiva.
- Una herramienta que habría ahorrado veinte pasos simplemente no existe.

Todo está en el log. Nada de ello llega a la sesión siguiente.

## Cómo funciona

Dos bucles, deliberadamente separados. El primero se ejecuta solo y no consume atención. El segundo se ejecuta a petición y produce una decisión cada vez.

### Captura

Cada llamada a herramienta y cada prompt se añaden a un log paralelo en `.retro/sessions/<id>.jsonl`. No interviene ningún modelo: el plugin solo escribe. Por eso el log es independiente de la compactación del contexto; la trayectoria en bruto sobrevive a lo que la sesión haga con su propio historial.

Cuando una sesión termina, queda en cola. El primer prompt de la sesión siguiente liquida esa cola con una única llamada al modelo en un contexto limpio, deliberadamente no el agente que hizo el trabajo, que defendería sus propias decisiones.

Esa llamada recibe una vista comprimida de la sesión: la salida de las herramientas se recorta y los prompts y las respuestas se conservan completos. Responde a una sola pregunta:

> Si esta sesión volviera a ejecutarse, ¿qué debería cambiar en el proyecto para que fuera más corta y más recta?

La respuesta es una lista de lecciones en `.retro/lessons/`.

Las lecciones aparecen con una sesión de retraso. Un proyecto que no se vuelve a abrir no cuesta nada, y `/retro` liquida la cola a petición.

### Qué guía la extracción

Los criterios no están compilados en el plugin. Residen en `.retro/prompts/extract.md`, un archivo que se puede leer y editar, y describen las formas que vale la pena buscar:

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
| `/retro` | Entrega una lección, la de mayor puntuación aún sin decidir. |
| `/retro auto` | Entrega todas las lecciones pendientes como un único plan, para aprobarlo de una pasada. |
| `/retro check` | Informa de si el plugin está funcionando. |

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

`/retro auto` es la misma entrega para todo a la vez. Las lecciones pendientes se ordenan, las que siguen en pie se reúnen en un único plan agrupado por archivo, y el plan se aprueba una sola vez.

### Dónde corresponde el arreglo

Una propuesta es una sugerencia, no un esquema. Los destinos habituales:

- Una skill, corregida o ampliada con la forma en que la tarea se hace realmente en este proyecto.
- Una instrucción para `AGENTS.md`: un hecho o una restricción.
- Una herramienta que falta, redactada como petición junto con el coste que ya ha provocado.
- Un cambio en el propio código, para que la trampa desaparezca. Nunca se aplica de forma automática.
- Algo que no encaja en ninguno de los anteriores, que queda para que lo sitúe la persona.

Las lecciones en sí son siempre locales a un espacio de trabajo. Una lección es evidencia de sesiones de un único proyecto, así que vive en ese proyecto y en ningún otro sitio.

El arreglo, en cambio, puede corresponder a otro lugar. Parte de la fricción es propia del repositorio: una skill que no le conviene, una instrucción que allí no es cierta. Parte de la fricción tiene que ver con hábitos que viajan: cómo se usa el gestor de incidencias, cómo se nombran las ramas, qué convención se lleva de un proyecto a otro. Lo primero pertenece al entorno del proyecto; lo segundo, al global, en `~/.config/opencode/AGENTS.md` o en una skill global.

Cuál de los dos pide una lección se resuelve en el momento de la entrega. El plugin no lo adivina y nunca edita un entorno global por su cuenta.

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

## Lo que no es

- **No es un plugin de memoria.** Los plugins de memoria construyen una base de conocimiento que el agente tiene que acordarse de consultar. Este edita los archivos que el entorno ya lee. El conocimiento que vive en una skill no hace falta recordarlo.
- **No es un rompedor de bucles.** Los detectores de bucles detienen al agente en el momento. Este plugin trabaja sobre la sesión siguiente. Ambos son útiles.
- **No es un recolector de éxitos.** La mayoría de las herramientas de skills que se mejoran a sí mismas registran lo que funcionó. Esta registra lo que no funcionó, que es donde están las victorias baratas.

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

`options.model` es obligatorio. Sin él, OpenCode resuelve su propia capa gratuita, que un plugin no puede usar.

Todo lo demás es opcional: `dir` para el directorio, por omisión `.retro`; `prompts` para el directorio de prompts; `halfLife` en sesiones, por omisión diez; `autoLimit`, el número de lecciones en un `/retro auto`, por omisión diez; `maxOutput`, `extractTimeoutMs`, `keepSessions`.

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

Un log se borra en cuanto su sesión ha sido extraída. La historia la lleva la propia lección y el rango de pasos lo lleva la evidencia, así que el log en bruto ya no aporta nada.

### Prompts

Tres prompts determinan lo que hace el plugin, y los tres son archivos dentro del proyecto: qué cuenta como lección, cómo se entrega una lección y cómo un lote de lecciones se convierte en un plan.

Cada uno se siembra desde el valor por omisión del paquete en la primera ejecución y no se vuelve a escribir. La resolución va primero por el proyecto, después por `~/.config/opencode/retro/prompts/` y por último por el valor del paquete, de modo que un prompt puede fijarse para un proyecto, para todos o para ninguno.

Cuando se publica un valor por omisión más nuevo, aparece como `prompts/updates/<name>.vN.md`, con una nota al principio que advierte de que ese archivo no está en uso. Nada se aplica en nombre del usuario.

Lo que permanece en el código es la maquinaria: el formato de salida que requiere el analizador, el orden de los campos de una lección y la instrucción de registrar la decisión. `/retro check` imprime el formato de salida para quien quiera verlo.

## Comprobar que funciona

Que un hook se registre no demuestra nada. Un hook registrado con un nombre que la API ya no usa se registra con éxito y luego no se dispara nunca.

Por eso `.retro/selfcheck.md` informa de que está vivo, no de que está instalado: compara lo que vio el flujo de eventos con lo que recibieron los hooks. El archivo lleva su propia regla de caducidad:

> Si hay trabajo en curso y `heartbeat` tiene más de unos pocos minutos, el plugin no está en marcha.

`/retro check` es la versión activa. Informa de las versiones del plugin y de OpenCode, de la superficie de API de la que el plugin depende, de si el modelo configurado responde, de qué capa de prompts está vigente y de si el formato de salida sigue produciendo una lección analizable.

## Hoja de ruta

La autonomía se gana a partir del propio registro de propuestas aceptadas y rechazadas, no se concede de antemano.

| Nivel | El plugin | La persona | |
|---|---|---|---|
| L0 | captura sesiones y extrae lecciones | lee `lessons/` directamente | disponible |
| L1 | propone una lección cada vez | decide, con el agente | disponible |
| L1.5 | planifica de una vez todas las pendientes | aprueba el plan una vez | disponible |
| L2 | aplica a una rama las lecciones confirmadas | revisa el lote | previsto |
| L3 | aplica skills e instrucciones directamente | solo ve peticiones de herramientas y refactorizaciones | previsto |

## Requisitos

- OpenCode v2, `@opencode/plugin` 2.0 o posterior. Verificado contra 2.0.32.
- Un modelo para la extracción, nombrado explícitamente en `options.model`. Uno económico es suficiente.
- Ninguna dependencia en tiempo de ejecución.

## Licencia

MIT
