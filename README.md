# Scanner de ETFs — versión familiar (web real)

Web real y gratuita del Scanner de ETFs de Fernando, fuera de Muse, para compartir con un solo enlace (empezando por su hermano). Página + servidor en Node.js 24 **sin ninguna dependencia externa**: solo `node:http` y `fetch` nativo.

## Cómo correrlo local

```bash
cd scanner-web-familiar
node server.js
```

Abre http://localhost:3000 — el puerto se puede cambiar con la variable `PORT` (ej: `PORT=8080 node server.js`).

## Qué hace

- El servidor pide a Yahoo Finance (API de gráficos `v8/finance/chart`, con `User-Agent` de navegador; si `query1` falla reintenta con `query2`) los cierres diarios del último año de cada símbolo.
- Endpoint JSON: `GET /api/scanner` devuelve los 10 símbolos iniciales (SPYM, QQQM, SCHD, RSP, JEPQ, SPMO, VTI, SCHG, META y AAPL). Acepta `?symbols=SPYM,QQQM` para pedir otros símbolos (los que el usuario agregue en la página). La fila de Apple se consulta como **AAPL** y se muestra como **«APPLE»**, igual que en el scanner de Fernando.
- Caché en memoria de 15 minutos por símbolo. La página se auto-refresca sola cada 15 minutos y muestra «Actualizado: <hora>».
- Tipo tomado de Yahoo (`instrumentType`): ETF → píldora «ETF» morada; EQUITY → «Stock» celeste.

## Cálculos (en el servidor)

- Precio actual (`regularMarketPrice`) y Cambio % del día.
- **RSI 14 Wilder** sobre la serie completa de cierres.
- **SMA 20/50/100/200**, distancia % del precio a cada una y texto de posición (ej: «Debajo de todas las SMA»).
- **Señal — regla exacta de Fernando, solo estas 3 etiquetas (sin RSI desde el 24/10/2026):**
  - **Favorable**: precio debajo de TODAS las SMA.
  - **No Favorable**: precio sobre 3 o más SMA.
  - **Interesante**: todo lo demás.
- **Días en señal**: racha de días de mercado consecutivos terminando hoy con la misma señal actual, recalculando la señal día por día (solo SMA de cada día con los datos hasta ese día).
- **🎯 Cerca SMA 200**: marca en la fila y filtro para los símbolos a menos de 1% de su SMA 200. Si el precio está por encima, la marca dice «Casi en zona premium» (por entrar al punto 1 del curso); si está por debajo, «Saliendo de zona premium». En el detalle, la distancia a la SMA 200 se resalta cuando está en la banda.
- **Próximo punto**: columna que dice cuánto tiene que caer el precio para tocar la siguiente media del curso, en orden 20 → 50 → 100 → 200 (ej: «−3,20% → SMA 20 (Punto 4)»). Si ya está debajo de todas, dice «En Punto 1 · zona premium». Es el punto OBJETIVO, distinto de la marca 🎯 (que solo mira la cercanía a la SMA 200).
- **Mini-gráfico**: sparkline de 6 meses en cada fila (serie de cierres que ya trae el servidor); verde si subió en el periodo, roja si bajó.
- **Insignia Punto del profesor**: marca en la fila con el punto ACTUAL del curso — Punto 1 si está debajo de todas las SMA (zona premium), Punto 2 si está debajo de la 100 pero sobre la 200, Punto 3 si está debajo de la 50 pero sobre la 100, Punto 4 si está debajo de la 20 pero sobre la 50; si está sobre todas, «Sin punto». Distinta de la columna «Próximo punto» (que dice cuál viene después).
- **🧮 Calculadora de proyección** (debajo de la tabla, 25/10/2026): usa los símbolos de la lista del visitante. Cada símbolo lleva un peso con deslizador y su rendimiento anual histórico (endpoint `GET /api/cagr?symbols=...`: CAGR a 5 años con precios ajustados, o desde que existe si tiene al menos 1 año; menos de 1 año queda sin historia y fuera del cálculo, avisado). El usuario pone capital inicial, aporte mensual y años; la calculadora pondera los rendimientos (pesos normalizados a 100%) y proyecta con interés compuesto mensual: total aportado, valor proyectado, ganancia proyectada y curva año por año. Valores por defecto: $9,000 / $1,000 al mes / 8 años (el plan de Fernando). Simulación educativa con aviso: el rendimiento pasado no garantiza resultados futuros; no es asesoría financiera.
- **Rango 52 semanas** y serie de 6 meses (cierres + SMA 20/50) para el gráfico del detalle de cada fila.

## Fórmula del Nivel 0–100

La fórmula es propia, simple y determinista, y es exactamente esta (la misma que usa el código y la misma que explica la sección «Cómo leer el scanner» de la página):

Nivel = redondeo de [ 0,6 × (100 − RSI 14) + 0,4 × (25 × número de SMA (20/50/100/200) que están por encima del precio) ], limitado entre 0 y 100.

Es decir: un Nivel más alto combina un RSI bajo (precio menos extendido) con el precio por debajo de más SMA. Si faltara alguna SMA por historial corto, esa SMA simplemente no cuenta en el número de SMA por encima del precio.

## Despliegue gratis en Render (sin desplegar desde aquí)

La cuenta de hosting la crea Fernando. Pasos:

1. Subir esta carpeta (`scanner-web-familiar/`) a un repositorio de GitHub.
2. En https://render.com → **New + → Web Service** → conectar el repositorio.
3. Configuración del servicio:
   - **Runtime**: Node
   - **Build Command**: (dejar vacío — no hay dependencias que instalar)
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
4. Render asigna el puerto automáticamente con la variable `PORT` (el servidor ya la respeta) y entrega una dirección pública tipo `https://<nombre>.onrender.com` — ese es el enlace para compartir.
5. Nota de la capa Free de Render: el servicio se duerme tras un rato sin visitas y la primera apertura puede tardar ~30–60 segundos en despertar; después responde normal.

## Límites conocidos

- Yahoo Finance es una fuente **no oficial y de uso personal**: funciona sin clave, pero puede cambiar o limitar peticiones algún día. Para cobrar por el servicio haría falta una fuente de datos con licencia comercial.
- «Varias veces al día»: en horario de mercado la página se refresca cada 15 minutos (la caché del servidor también es de 15 minutos); las señales basadas en cierres diarios (RSI/SMA) solo cambian de verdad al cierre.
- Con `range=1y` hay ~252 cierres: la SMA 200 se puede calcular, pero la racha de «Días en señal» no puede remontarse más allá de donde la SMA 200 y el RSI son calculables a la vez.
- Si un símbolo devuelve menos de 200 cierres, se muestra con lo que haya (las SMA que no alcancen quedan en «—») sin inventar datos.

> Herramienta informativa y educativa. No es asesoría financiera.
