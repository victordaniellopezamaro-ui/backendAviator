const GameRound = require('../../models/Aviator/gameRoundModel');
const SignalModel = require('../../models/Aviator/signalModel');

/**
 * Servicio de detección de patrones para emitir señales
 * 
 * Patrón a detectar:
 * - Resultado 1: > 1.50x
 * - Resultado 2: > 1.50x
 * - Resultado 3: < 2.00x
 * 
 * Cuando se detecta este patrón, se emite una señal.
 * La señal se verifica con el siguiente resultado:
 * - Gana si el resultado es > 1.50x
 * - Pierde si el resultado es <= 1.50x (se permite 1 gale)
 */
class PatternDetectionService {
  constructor() {
    this.pendingSignals = new Map(); // bookmakerId -> signalId
    this.io = null;
  }

  /**
   * Inicializar el servicio
   */
  initialize(io) {
    this.io = io;
    console.log('[PatternDetection] ✅ Servicio de detección de patrones inicializado');
  }

  /**
   * Detectar patrón en los últimos resultados
   * Patrón: >1.50x, >1.50x, <2.00x
   */
  detectPattern(results) {
    if (!results || results.length < 3) {
      return false;
    }

    // Necesitamos al menos 3 resultados para detectar el patrón
    // Los resultados vienen ordenados DESC (más reciente primero)
    const result1 = parseFloat(results[0].max_multiplier) || 0;
    const result2 = parseFloat(results[1].max_multiplier) || 0;
    const result3 = parseFloat(results[2].max_multiplier) || 0;

    // Patrón: >1.50x, >1.50x, <2.00x
    const patternDetected = 
      result1 > 1.50 &&
      result2 > 1.50 &&
      result3 < 2.00;

    if (patternDetected) {
      console.log(`[PatternDetection] 🎯 Patrón detectado: ${result1.toFixed(2)}x, ${result2.toFixed(2)}x, ${result3.toFixed(2)}x`);
      return {
        detected: true,
        pattern: [result1, result2, result3]
      };
    }

    return { detected: false };
  }

  /**
   * Procesar nuevo resultado y verificar señales pendientes
   */
  async processNewResult(bookmakerId, roundId, multiplier) {
    try {
      // Verificar si este resultado ya fue procesado (evitar duplicados)
      const resultKey = `${bookmakerId}_${roundId}_${multiplier}`;
      if (this.processedResults && this.processedResults.has(resultKey)) {
        console.log(`[PatternDetection] ⚠️ Resultado ${roundId} (${multiplier}x) ya fue procesado, omitiendo`);
        return;
      }
      
      // Marcar como procesado
      if (!this.processedResults) {
        this.processedResults = new Set();
      }
      this.processedResults.add(resultKey);
      
      // Limpiar resultados procesados antiguos (mantener solo últimos 1000)
      if (this.processedResults.size > 1000) {
        const array = Array.from(this.processedResults);
        this.processedResults = new Set(array.slice(-500)); // Mantener últimos 500
      }

      // Verificar si hay señales pendientes para este bookmaker
      const pendingSignalId = this.pendingSignals.get(bookmakerId);
      
      if (pendingSignalId) {
        // Hay una señal pendiente, verificar resultado
        await this.verifySignal(pendingSignalId, bookmakerId, roundId, multiplier);
      }

      // Obtener últimos 5 resultados para detectar nuevos patrones
      // IMPORTANTE: Usar DISTINCT para evitar duplicados en la consulta
      const lastResults = await GameRound.getLastResults(bookmakerId, 5);
      
      // Filtrar duplicados por round_id antes de analizar
      const uniqueResults = [];
      const seenRoundIds = new Set();
      for (const result of lastResults) {
        if (!seenRoundIds.has(result.round_id)) {
          seenRoundIds.add(result.round_id);
          uniqueResults.push(result);
        }
      }
      
      if (uniqueResults.length >= 3) {
        const patternCheck = this.detectPattern(uniqueResults);
        
        if (patternCheck.detected) {
          // Emitir nueva señal
          await this.emitSignal(bookmakerId, patternCheck.pattern);
        }
      }
    } catch (error) {
      console.error(`[PatternDetection] ❌ Error procesando resultado:`, error.message);
    }
  }

  /**
   * Emitir una nueva señal
   */
  async emitSignal(bookmakerId, pattern) {
    try {
      // Verificar si ya hay una señal pendiente para este bookmaker
      if (this.pendingSignals.has(bookmakerId)) {
        console.log(`[PatternDetection] ⚠️ Ya existe una señal pendiente para bookmaker ${bookmakerId}`);
        return;
      }

      // Crear señal en la base de datos
      const signal = await SignalModel.createSignal(bookmakerId, pattern);
      
      // Guardar referencia de señal pendiente
      this.pendingSignals.set(bookmakerId, signal.id);

      console.log(`[PatternDetection] 🚨 SEÑAL EMITIDA para bookmaker ${bookmakerId} - Signal ID: ${signal.id}`);
      console.log(`[PatternDetection] 📊 Patrón: ${pattern.map(p => p.toFixed(2) + 'x').join(', ')}`);

      // Emitir evento WebSocket
      if (this.io) {
        this.io.emit('signalEmitted', {
          signalId: signal.id,
          bookmakerId: bookmakerId,
          pattern: pattern,
          timestamp: signal.signal_timestamp
        });
      }

      return signal;
    } catch (error) {
      console.error(`[PatternDetection] ❌ Error emitiendo señal:`, error.message);
      throw error;
    }
  }

  /**
   * Verificar resultado de una señal pendiente
   */
  async verifySignal(signalId, bookmakerId, roundId, multiplier) {
    try {
      const multiplierValue = parseFloat(multiplier) || 0;
      const isWin = multiplierValue > 1.50;

      // Obtener la señal actual
      const pendingSignals = await SignalModel.getPendingSignals(bookmakerId);
      const signal = pendingSignals.find(s => s.id === signalId);

      if (!signal) {
        console.log(`[PatternDetection] ⚠️ Señal ${signalId} no encontrada o ya procesada`);
        this.pendingSignals.delete(bookmakerId);
        return;
      }

      // Verificar si es el primer intento o el gale
      const isFirstAttempt = !signal.first_attempt_result;

      if (isFirstAttempt) {
        // Primer intento
        console.log(`[PatternDetection] 🎲 Primer intento - Resultado: ${multiplierValue.toFixed(2)}x - ${isWin ? '✅ GANÓ' : '❌ PERDIÓ'}`);
        
        await SignalModel.updateFirstAttempt(signalId, multiplierValue, roundId);

        if (isWin) {
          // Ganó en el primer intento, señal completada
          console.log(`[PatternDetection] ✅ Señal ${signalId} GANADA en primer intento`);
          this.pendingSignals.delete(bookmakerId);
          
          // Emitir evento
          if (this.io) {
            this.io.emit('signalResult', {
              signalId: signalId,
              bookmakerId: bookmakerId,
              attempt: 1,
              result: multiplierValue,
              status: 'won',
              galeUsed: false
            });
          }
        } else {
          // Perdió, esperar gale (siguiente resultado)
          console.log(`[PatternDetection] ⏳ Señal ${signalId} perdió primer intento, esperando gale...`);
          
          // Emitir evento
          if (this.io) {
            this.io.emit('signalResult', {
              signalId: signalId,
              bookmakerId: bookmakerId,
              attempt: 1,
              result: multiplierValue,
              status: 'pending_gale',
              galeUsed: false
            });
          }
        }
      } else {
        // Segundo intento (gale)
        console.log(`[PatternDetection] 🎲 Segundo intento (GALE) - Resultado: ${multiplierValue.toFixed(2)}x - ${isWin ? '✅ GANÓ' : '❌ PERDIÓ'}`);
        
        await SignalModel.updateSecondAttempt(signalId, multiplierValue, roundId);
        
        // Señal completada (ganó o perdió)
        this.pendingSignals.delete(bookmakerId);
        
        const finalStatus = isWin ? 'won' : 'lost';
        console.log(`[PatternDetection] ${isWin ? '✅' : '❌'} Señal ${signalId} ${finalStatus.toUpperCase()} en gale`);
        
        // Emitir evento
        if (this.io) {
          this.io.emit('signalResult', {
            signalId: signalId,
            bookmakerId: bookmakerId,
            attempt: 2,
            result: multiplierValue,
            status: finalStatus,
            galeUsed: true
          });
        }
      }
    } catch (error) {
      console.error(`[PatternDetection] ❌ Error verificando señal:`, error.message);
      // Limpiar señal pendiente en caso de error
      this.pendingSignals.delete(bookmakerId);
    }
  }

  /**
   * Obtener señales pendientes
   */
  getPendingSignals() {
    return Array.from(this.pendingSignals.entries()).map(([bookmakerId, signalId]) => ({
      bookmakerId,
      signalId
    }));
  }
}

module.exports = new PatternDetectionService();

