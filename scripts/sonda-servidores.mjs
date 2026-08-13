#!/usr/bin/env node
/**
 * Sonda de estado de los ambientes de AgroSistemas.
 *
 * Chequea produccion, stage y devapp, clasifica el estado y mantiene
 * `estado-servidores.json` con el estado actual y el historial de eventos.
 *
 * Como distingue un deploy de una caida, sin credenciales:
 *  - 502/503/504  -> el contenedor esta reiniciando: DEPLOYANDO
 *  - no responde  -> CAIDO
 *  - 200 pero la huella del build cambio -> el deploy TERMINO (y con que build)
 *  - 200 y huella igual -> OK  (si tarda mucho, DEGRADADO)
 *
 * La huella del build sale de los hashes de los assets de Next
 * (/_next/static/chunks/*.css), que cambian en cada compilacion.
 *
 * Uso:  node scripts/sonda-servidores.mjs [--json ruta] [--timeout ms]
 * Salida: escribe el JSON y, si hubo transiciones, las imprime en stdout
 *         como lineas ALERTA| para que el workflow las mande a Discord.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const AMBIENTES = [
  { id: 'produccion', nombre: 'Producción', url: 'https://app.agrosistemas.com.ar/ingresar' },
  { id: 'stage', nombre: 'Stage', url: 'https://stage.agrosistemas.com.ar/ingresar' },
  { id: 'devapp', nombre: 'Devapp', url: 'https://devapp.agrosistemas.com.ar/ingresar' },
];

const args = process.argv.slice(2);
const opt = (n, def) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const RUTA_JSON = opt('--json', 'estado-servidores.json');
const TIMEOUT = Number(opt('--timeout', '20000'));
const LENTO_MS = Number(opt('--lento', '6000'));
const MAX_HISTORIAL = 300;

/** Huella del build: hashes de los assets de Next que aparecen en el HTML. */
function huellaDeBuild(html) {
  const hashes = [...html.matchAll(/\/_next\/static\/(?:chunks|css)\/([A-Za-z0-9_-]{8,})/g)]
    .map((m) => m[1]);
  if (!hashes.length) return null;
  const unicos = [...new Set(hashes)].sort();
  return createHash('sha1').update(unicos.join('|')).digest('hex').slice(0, 12);
}

async function unIntento(amb) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const reloj = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(amb.url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'panel-celulas-sonda/1.0' },
    });
    const ms = Date.now() - t0;
    let huella = null;
    if (res.status === 200) {
      const html = await res.text();
      huella = huellaDeBuild(html);
    }
    return { httpStatus: res.status, ms, huella, error: null };
  } catch (e) {
    return {
      httpStatus: 0,
      ms: Date.now() - t0,
      huella: null,
      error: e.name === 'AbortError' ? `sin respuesta en ${TIMEOUT} ms` : String(e.message || e).slice(0, 120),
    };
  } finally {
    clearTimeout(reloj);
  }
}

/**
 * Sondea con reintentos. La red del runner falla de a ratos, y un solo timeout
 * no alcanza para decir que un ambiente se cayo: se reintenta 3 veces con
 * espera creciente y se toma el mejor resultado.
 */
async function sondear(amb) {
  let ultimo = null;
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, i * 2500));
    ultimo = await unIntento(amb);
    if (ultimo.httpStatus >= 200 && ultimo.httpStatus < 400) return { ...ultimo, intentos: i + 1 };
  }
  return { ...ultimo, intentos: 3 };
}

/** Clasifica el estado a partir de la respuesta y de lo que sabíamos antes. */
function clasificar(r, previo) {
  if (r.httpStatus === 0) {
    return { estado: 'caido', detalle: r.error || 'no responde' };
  }
  if ([502, 503, 504].includes(r.httpStatus)) {
    return { estado: 'deployando', detalle: `el servidor devuelve ${r.httpStatus} (contenedor reiniciando)` };
  }
  if (r.httpStatus >= 500) {
    return { estado: 'caido', detalle: `error del servidor (${r.httpStatus})` };
  }
  if (r.httpStatus >= 400) {
    return { estado: 'degradado', detalle: `respuesta inesperada (${r.httpStatus})` };
  }
  const huellaPrevia = previo?.huella || null;
  if (r.huella && huellaPrevia && r.huella !== huellaPrevia) {
    return { estado: 'ok', detalle: `versión nueva publicada (build ${r.huella})`, deployTermino: true };
  }
  if (r.ms > LENTO_MS) {
    return { estado: 'degradado', detalle: `responde lento (${(r.ms / 1000).toFixed(1)} s)` };
  }
  return { estado: 'ok', detalle: `responde en ${(r.ms / 1000).toFixed(1)} s` };
}

const ETIQUETA = {
  ok: '🟢 En servicio',
  deployando: '🔵 Deployando',
  degradado: '🟡 Degradado',
  caido: '🔴 Caído',
};

function mensajeTransicion(amb, antes, ahora, detalle, deployTermino) {
  const de = antes ? ETIQUETA[antes] || antes : 'sin dato';
  if (deployTermino) return `✅ **${amb.nombre}**: deploy terminado — ${detalle}`;
  if (ahora === 'deployando') return `🔵 **${amb.nombre}**: empezó un deploy — ${detalle}`;
  if (ahora === 'caido') return `🔴 **${amb.nombre}**: CAÍDO — ${detalle}`;
  if (ahora === 'degradado') return `🟡 **${amb.nombre}**: degradado — ${detalle}`;
  if (ahora === 'ok' && antes === 'deployando') return `✅ **${amb.nombre}**: volvió a estar en servicio después del deploy — ${detalle}`;
  if (ahora === 'ok') return `🟢 **${amb.nombre}**: recuperado (venía de ${de}) — ${detalle}`;
  return `**${amb.nombre}**: ${de} → ${ETIQUETA[ahora] || ahora} — ${detalle}`;
}

// ---------------------------------------------------------------- main
const anterior = existsSync(RUTA_JSON)
  ? JSON.parse(readFileSync(RUTA_JSON, 'utf8'))
  : { ambientes: {}, historial: [] };

const ahoraISO = new Date().toISOString();
const salida = { actualizado: ahoraISO, ambientes: {}, historial: anterior.historial || [] };
const alertas = [];

for (const amb of AMBIENTES) {
  const previo = anterior.ambientes?.[amb.id];
  const r = await sondear(amb);
  let { estado, detalle, deployTermino } = clasificar(r, previo);

  // Doble confirmacion antes de declarar una caida: un unico fallo puede ser la
  // red del runner, no el servidor. Recien con dos chequeos seguidos fallidos se
  // marca caido y se avisa; el primero queda como "verificando".
  const fallo = estado === 'caido';
  const fallosSeguidos = fallo ? (previo?.fallosSeguidos || 0) + 1 : 0;
  if (fallo && fallosSeguidos < 2) {
    estado = previo?.estado && previo.estado !== 'caido' ? previo.estado : 'degradado';
    detalle = `no respondió en este chequeo (${r.error || 'sin respuesta'}) — se confirma en el próximo`;
    deployTermino = false;
  }

  const cambio = !previo || previo.estado !== estado || deployTermino;
  salida.ambientes[amb.id] = {
    nombre: amb.nombre,
    url: amb.url.replace('/ingresar', ''),
    estado,
    detalle,
    httpStatus: r.httpStatus,
    ms: r.ms,
    huella: r.huella || previo?.huella || null,
    desde: cambio ? ahoraISO : previo?.desde || ahoraISO,
    ultimoChequeo: ahoraISO,
    ultimoDeploy: deployTermino ? ahoraISO : previo?.ultimoDeploy || null,
    fallosSeguidos,
    intentos: r.intentos || 1,
  };

  if (cambio) {
    const texto = mensajeTransicion(amb, previo?.estado, estado, detalle, deployTermino);
    salida.historial.unshift({
      cuando: ahoraISO,
      ambiente: amb.id,
      estado,
      detalle,
      deployTermino: !!deployTermino,
      texto,
    });
    if (previo) alertas.push(texto);   // en la primera corrida no alerta: no hay con qué comparar
  }
  const marca = fallo && fallosSeguidos === 1 ? '⏳ Verificando' : ETIQUETA[estado];
  console.log(`${marca}  ${amb.nombre.padEnd(11)} http=${r.httpStatus} ${String(r.ms).padStart(5)}ms intentos=${r.intentos || 1} build=${r.huella || '-'} ${cambio ? '(cambio)' : ''}`);
}

salida.historial = salida.historial.slice(0, MAX_HISTORIAL);
writeFileSync(RUTA_JSON, JSON.stringify(salida, null, 2) + '\n');
console.log(`\nJSON escrito en ${RUTA_JSON} (${salida.historial.length} eventos en el historial)`);

for (const a of alertas) console.log(`ALERTA|${a}`);
if (!alertas.length) console.log('sin transiciones: no hay nada que avisar');
