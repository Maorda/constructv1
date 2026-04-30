import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { OperatorsMathHandleUtil } from '@database/utils/operators/operators.math.util';
import { ValidationHandleUtil } from '@database/utils/validation.util';
import { OperatorsMutationHandleUtil } from '@database/utils/operators/operators.mutation.util';
import { OperatorsComparationsHandleUtil } from '@database/utils/operators/operators.comparations.util';
import { OperatorsCollectionHandleUtil } from '@database/utils/operators/operators.collection.util';
import { BaseEngine } from '../engines/Base.Engine';
import { ClassType } from '@database/types/query.types';
import { SheetsDataGateway } from '@database/services/sheetDataGateway';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { GettersEngine } from './getters.engine';
import { ModuleRef } from '@nestjs/core';
import { RELATION_METADATA_KEY } from '@database/decorators/relation.decorator';



export class ManipulateEngine extends BaseEngine {
    private errors: string[] = [];
    private readonly logger = new Logger(ManipulateEngine.name);


    constructor(
        entityClass: ClassType,
        private readonly gateway: SheetsDataGateway,
        @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly getterEngine: GettersEngine,
        private readonly moduleRef: ModuleRef

    ) { super(entityClass); }

    /**
         * @description: Este metodo es el que se encarga de manejar las operaciones de insercion en hojas relacionadas.
         * @param parentEntity: Entidad padre.
         * @param dataToPush: Datos a insertar.
         * @param arrayFilters: Filtros de busqueda.
         * @returns: void
         */


    async handlePushOperation(
        parentEntity: any,
        dataToPush: Record<string, any>,
        arrayFilters?: any[]
    ): Promise<void> {
        // dataToPush viene como { asistencias: { fecha: '2026-04-21', estado: 'PRESENTE' } }
        const paths = Object.keys(dataToPush);

        for (const path of paths) {
            // 1. Obtener metadatos de la relación (@Relation)
            const target = parentEntity.constructor.prototype;
            const relation = Reflect.getMetadata(RELATION_METADATA_KEY, target, path);

            if (!relation) {
                throw new Error(`No se encontró una relación definida para el path: ${path}`);
            }

            // 2. Obtener el servicio destino mediante ModuleRef
            const targetService = this.moduleRef.get(relation.targetService, { strict: false });

            // 3. Preparar el nuevo objeto a insertar
            // Inyectamos la Foreign Key automáticamente
            const newItem = {
                ...dataToPush[path],
                [relation.joinColumn]: parentEntity.id // Conectamos con el padre
            };

            // 4. Ejecutar el CREATE en la hoja destino
            await targetService.create(newItem);
        }
    }
    /**
       * Convierte un objeto JSON a un arreglo plano basado en las cabeceras
       * para poder insertarlo en la hoja.
       */
    async appendObject(sheetName: string, data: any) {
        const values = await this.gateway.getValues(this.optionsDatabase.defaultSpreadsheetId, `${sheetName}!1:1`);
        const headers = values[0] || [];

        // Mapeamos el objeto al orden de las columnas de la hoja
        const row = headers.map(header => data[header] ?? '');

        try {
            return await this.gateway.append(sheetName, row);
        } catch (error) {
            throw new InternalServerErrorException('Error al escribir en Google Sheets.');
        }
    }
    /**
     * Ejecuta las transformaciones sobre los datos de entrada.
     * @param updateData Los datos que vienen en el $set o el update
     * @param currentRecord El registro existente en la hoja (para contexto de variables)
     */
    execute(data: any, record: any = {}): any {
        if (!data || typeof data !== 'object') return data;
        // Clonamos para evitar mutar el objeto original por referencia
        const dataClone = JSON.parse(JSON.stringify(data));
        return this.executePipeline(dataClone, record);
    }




    public prepareForSave(data: any, currentRecord: any = {}): any {
        this.errors = [];
        // Clonamos para evitar efectos secundarios en el DTO original
        const clonedData = JSON.parse(JSON.stringify(data));

        const result = this.executePipeline(clonedData, currentRecord);

        if (this.errors.length > 0) {
            throw new InternalServerErrorException({
                message: 'Errores de validación o procesamiento en el motor',
                errors: this.errors,
            });
        }

        return result;
    }

    private executePipeline(obj: any, record: any): any {
        for (const key in obj) {
            const value = obj[key];
            // Si es un objeto (posible operador) y no es nulo ni arreglo
            if (value && typeof value === 'object' && !Array.isArray(value)) {

                // 0. VALIDACIÓN (Prioridad Alta)
                if (value.hasOwnProperty('$validate')) {
                    this.runValidation(key, value.value, value.$validate);
                    obj[key] = value.value; // Extraemos el valor tras validar
                    // Continuamos para ver si el valor extraído tiene más operadores
                }
                // 1. TRANSFORMACIONES DE TEXTO
                if (value.hasOwnProperty('$upper')) {
                    const resolved = this.resolveValue(value.$upper, record);
                    obj[key] = OperatorsMutationHandleUtil.mutationHandlers.upper(resolved);
                    continue;
                }

                // --- 2. OPERADOR $trim ---
                if (value.hasOwnProperty('$trim')) {
                    const resolved = this.resolveValue(value.$trim, record);
                    obj[key] = OperatorsMutationHandleUtil.mutationHandlers.trim(resolved);
                    continue;
                }

                // --- 3. OPERADOR CONDICIONAL $if ---
                if (value.hasOwnProperty('$if')) {
                    // Primero: Evaluamos la condición (devuelve true/false)
                    const conditionResult = this.evaluateCondition(value.$if, record);

                    // Segundo: Usamos el handler de mutación para elegir el camino
                    const chosenPath = OperatorsMutationHandleUtil.mutationHandlers.conditional({
                        if: conditionResult,
                        then: value.then,
                        else: value.else
                    });

                    // Tercero: Si el camino elegido es otro operador (recursión), lo procesamos
                    obj[key] = (chosenPath && typeof chosenPath === 'object')
                        ? this.executePipeline({ [key]: chosenPath }, record)[key]
                        : chosenPath;

                    continue;
                }

                // 3. OPERADORES MATEMÁTICOS
                if (value.hasOwnProperty('$inc')) {
                    obj[key] = OperatorsMathHandleUtil.MathHandlers.increment(record[key], value.$inc);
                    continue;
                }
                if (value.hasOwnProperty('$mul')) {
                    obj[key] = OperatorsMathHandleUtil.MathHandlers.multiply(record[key], value.$mul);
                    continue;
                }
                if (value.hasOwnProperty('$math')) {
                    obj[key] = OperatorsMathHandleUtil.MathHandlers.math(value.$math, record);
                    continue;
                }
                if (value.hasOwnProperty('$round')) {
                    // Si $round viene como objeto { val: ..., precision: ... }
                    const valToRound = typeof value.$round === 'object' ? value.$round.val : value.$round;
                    obj[key] = OperatorsMathHandleUtil.MathHandlers.round(valToRound, value.$round.precision);
                    continue;
                }

                // 4. OPERADORES DE COLECCIÓN (Agregaciones)
                if (value.hasOwnProperty('$sum')) {
                    obj[key] = OperatorsCollectionHandleUtil.CollectionHandlers.aggregate(value.$sum, 'sum');
                    continue;
                }
                if (value.hasOwnProperty('$avg')) {
                    obj[key] = OperatorsCollectionHandleUtil.CollectionHandlers.aggregate(value.$avg, 'avg');
                    continue;
                }

                // 5. OPERADORES DE FECHA
                if (value.hasOwnProperty('$dateAdd')) {
                    const config = value.$dateAdd;

                    // Resolvemos: 
                    // 1. Si hay startDate en el config, la usamos.
                    // 2. Si no, intentamos usar el valor actual de la propiedad en el objeto (record[key]).
                    const baseDate = this.resolveValue(config.startDate || config.date || record[key], record);
                    const amount = Number(this.resolveValue(config.amount, record)) || 0;
                    const unit = config.unit;

                    obj[key] = OperatorsMutationHandleUtil.mutationHandlers.dateAdd(
                        baseDate,
                        amount,
                        unit
                    );
                    continue;
                }
                // 2. Operador Complejo: $dateDiff (Diferencia entre dos fechas)
                if (value.hasOwnProperty('$dateDiff')) {
                    const config = value.$dateDiff;
                    const startDate = this.resolveValue(config.startDate, record);
                    const endDate = this.resolveValue(config.endDate, record);
                    const unit = config.unit || 'days';

                    obj[key] = OperatorsMutationHandleUtil.mutationHandlers.dateDiff(startDate, endDate, unit);
                    continue;
                }

                // 3. Operador: $dateTrunc (Redondeo de fechas al inicio de mes, año, etc.)
                if (value.hasOwnProperty('$dateTrunc')) {
                    const config = value.$dateTrunc;
                    const date = this.resolveValue(config.date || config, record);
                    const unit = config.unit || 'month';

                    obj[key] = OperatorsMutationHandleUtil.mutationHandlers.dateTrunc(date, unit);
                    continue;
                }

                // 4. Operadores de Extracción Simple ($year, $month, $day, $hour, etc.)
                // Estos operadores pueden venir como { $year: "$fecha" } o { $year: { date: "$fecha" } }
                const dateExtractors = [
                    '$day', '$month', '$year', '$week', '$dayOfMonth',
                    '$dayOfWeek', '$hour', '$minute', '$second'
                ];

                for (const op of dateExtractors) {
                    if (value.hasOwnProperty(op)) {
                        const config = value[op];
                        // Extraemos la fecha: puede ser el valor directo o una propiedad 'date'
                        const dateVal = this.resolveValue(config.date || config, record);

                        // El nombre del método en el handler suele ser el nombre del op sin el $
                        const methodName = op.substring(1);

                        obj[key] = OperatorsMutationHandleUtil.mutationHandlers[methodName](dateVal);
                        continue;
                    }
                }

                // 6. OPERADOR $concat
                // --- 6. OPERADOR $concat ---
                if (value.hasOwnProperty('$concat')) {
                    const rawParts = value.$concat;

                    // Aseguramos que sea un arreglo para que el .map no falle
                    const partsArray = Array.isArray(rawParts) ? rawParts : [rawParts];

                    // UNIFICACIÓN: Usamos el resolveValue del motor para limpiar cada parte
                    const resolvedParts = partsArray.map((part: any) => this.resolveValue(part, record));

                    // Llamamos al handler con el arreglo de strings/números ya resuelto
                    obj[key] = OperatorsMutationHandleUtil.mutationHandlers.concat(resolvedParts);
                    continue;
                }
                if (value.hasOwnProperty('$join')) {
                    const { data, delimiter } = value.$join;

                    // 1. Resolvemos el delimitador (por si fuera una referencia, aunque usualmente es fijo)
                    const resolvedDelimiter = this.resolveValue(delimiter, record) ?? ' ';

                    // 2. Resolvemos los elementos del arreglo 'data'
                    const rawData = Array.isArray(data) ? data : [];
                    const resolvedData = rawData.map((item: any) => this.resolveValue(item, record));

                    // 3. Llamamos al handler SIN enviar el 'record'. Solo enviamos datos limpios.
                    obj[key] = OperatorsMutationHandleUtil.mutationHandlers.join(resolvedData, resolvedDelimiter);
                    continue;
                }
                // --- SECCIÓN DE OPERADORES MATEMÁTICOS (MUTACIÓN) ---

                // 1. Operador: $multiply
                if (value.hasOwnProperty('$multiply')) {
                    // Obtenemos el valor actual de la celda en Google Sheets
                    const currentVal = Number(record[key] ?? 0);

                    // El factor puede ser un número fijo o una referencia a otra columna (ej: $factor_ajuste)
                    const factor = Number(this.resolveValue(value.$multiply, record)) || 1;

                    obj[key] = OperatorsMathHandleUtil.MathHandlers.multiply(currentVal, factor);
                    continue;
                }

                // --- OPERADOR $minMax (Selector de límites) ---
                if (value.hasOwnProperty('$minMax')) {
                    const config = value.$minMax;

                    // 1. Obtenemos el valor actual de la celda (current)
                    const currentValue = record[key];

                    // 2. Resolvemos el valor propuesto (target)
                    // Puede ser un número fijo o una referencia a otra columna
                    const targetValue = this.resolveValue(config.value ?? config, record);

                    // 3. Determinamos el tipo de comparación
                    const type = config.type || 'max'; // Por defecto 'max' si se pasa solo el valor

                    // Ejecutamos tu lógica
                    obj[key] = OperatorsMathHandleUtil.MathHandlers.minMax(
                        currentValue,
                        targetValue,
                        type
                    );
                    continue;
                }

                // --- OPERADOR $multiply ---
                if (value.hasOwnProperty('$multiply')) {
                    const currentVal = record[key];
                    const factor = this.resolveValue(value.$multiply, record);

                    obj[key] = OperatorsMathHandleUtil.MathHandlers.multiply(currentVal, factor);
                    continue;
                }
                // --- 8. OPERADOR $round ---
                if (value.hasOwnProperty('$round')) {
                    const params = value.$round;

                    let numberToRound: any;
                    let decimals: number = 2;

                    // Caso 1: Estructura completa { $round: { value: "$monto", decimals: 2 } }
                    if (typeof params === 'object' && params !== null && params.hasOwnProperty('value')) {
                        numberToRound = this.resolveValue(params.value, record);
                        decimals = params.hasOwnProperty('decimals')
                            ? Number(this.resolveValue(params.decimals, record))
                            : 2;
                    }
                    // Caso 2: Estructura simple { $round: "$monto" }
                    else {
                        numberToRound = this.resolveValue(params, record);
                    }

                    obj[key] = OperatorsMutationHandleUtil.mutationHandlers.round(numberToRound, decimals);
                    continue;
                }

                // RECURSIVIDAD: Si llegamos aquí y sigue siendo un objeto, profundizamos
                obj[key] = this.executePipeline(value, record);
            }
        }
        return obj;
    }



    private runValidation(fieldName: string, currentVal: any, config: any) {
        // 1. Validación de Obligatoriedad (Required)
        if (config.required) {
            const res = ValidationHandleUtil.ValidationHandlers.required(currentVal);
            if (typeof res === 'string') {
                this.errors.push(`${fieldName}: ${res}`);
                return; // Si es requerido y no está, no tiene sentido validar lo demás
            }
        }

        // Si el valor es nulo o indefinido y no es requerido, saltamos las demás validaciones
        if (currentVal === null || currentVal === undefined || currentVal === '') return;

        // 2. Validación de Valor Mínimo (min)
        if (config.min !== undefined) {
            const res = ValidationHandleUtil.ValidationHandlers.min(currentVal, config.min);
            if (typeof res === 'string') this.errors.push(`${fieldName}: ${res}`);
        }

        // 3. Validación de Valor Máximo (max)
        if (config.max !== undefined) {
            const res = ValidationHandleUtil.ValidationHandlers.max(currentVal, config.max);
            if (typeof res === 'string') this.errors.push(`${fieldName}: ${res}`);
        }

        // 4. Validación de Longitud de Texto (minLength / maxLength)
        if (config.minLength !== undefined) {
            if (String(currentVal).length < config.minLength) {
                this.errors.push(`${fieldName}: Debe tener al menos ${config.minLength} caracteres.`);
            }
        }

        if (config.maxLength !== undefined) {
            if (String(currentVal).length > config.maxLength) {
                this.errors.push(`${fieldName}: No puede superar los ${config.maxLength} caracteres.`);
            }
        }

        // 5. Validación de Formato Email
        if (config.email) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(String(currentVal))) {
                this.errors.push(`${fieldName}: El formato de correo electrónico no es válido.`);
            }
        }

        // 6. Validación de Patrón Personalizado (Regex)
        if (config.pattern && config.pattern instanceof RegExp) {
            if (!config.pattern.test(String(currentVal))) {
                this.errors.push(`${fieldName}: El valor no cumple con el formato requerido.`);
            }
        }

        // 7. Validación de Opciones Permitidas (enum / matches)
        if (config.in && Array.isArray(config.in)) {
            if (!config.in.includes(currentVal)) {
                this.errors.push(`${fieldName}: El valor debe ser uno de los siguientes: ${config.in.join(', ')}.`);
            }
        }
        // 8. VALIDACIÓN DE FECHA (isDate)
        if (config.isDate) {
            const date = new Date(currentVal);
            if (isNaN(date.getTime())) {
                this.errors.push(`${fieldName}: No es una fecha válida.`);
            }
        }

        // 9. VALIDACIÓN DE MONEDA PERUANA (Soles)
        // Verifica que sea un número positivo y, opcionalmente, con máximo 2 decimales
        if (config.isSoles) {
            const num = Number(currentVal);
            if (isNaN(num)) {
                this.errors.push(`${fieldName}: El monto debe ser un número válido.`);
            } else if (num < 0) {
                this.errors.push(`${fieldName}: El monto en Soles no puede ser negativo.`);
            }

            // Opcional: Validar que no tenga más de 2 decimales (céntimos)
            const parts = String(currentVal).split('.');
            if (parts[1] && parts[1].length > 2) {
                this.errors.push(`${fieldName}: El monto no puede tener más de 2 céntimos.`);
            }
        }
    }

    /**
    * Resuelve un valor dinámico. 
    * Si empieza con "$", busca la propiedad en el record.
    * Si es un valor estático, lo devuelve.
    */
    private resolveValue(val: any, record: any): any {
        if (typeof val === 'string' && val.startsWith('$')) {
            const fieldName = val.substring(1);
            // Retornamos null o undefined explícito si no existe para que los 
            // handlers decidan si usar un fallback (ej: new Date() o 0)
            return record && record.hasOwnProperty(fieldName) ? record[fieldName] : null;
        }
        return val;
    }
    // Implementación de lógica de comparación (Usando ComparisonHandlers)
    // Aquí invocarías a tus ComparisonHandlers.after, nin, etc.    
    private evaluateCondition(condition: any, record: any): boolean {
        if (!condition || typeof condition !== 'object') return false;

        const operator = Object.keys(condition)[0];
        const opKey = operator.startsWith('$') ? operator.substring(1) : operator;
        const args = condition[operator];
        const params = Array.isArray(args) ? args : [args];

        // UNIFICACIÓN: Ambos valores se resuelven igual
        const valA = this.resolveValue(params[0], record);
        const valB = this.resolveValue(params[1], record);

        //const handler = OperatorsComparationsHandleUtil.ComparisonHandlers[opKey];
        //return handler ? handler(valA, valB) : false;
        // TypeScript usará ComparisonHandlers.after(valA, valB)
        return OperatorsComparationsHandleUtil.ComparisonHandlers[opKey](valA, valB);
    }

}

// Obtenemos la fecha base (si se provee una propiedad de la entidad o un string)
/*export function getBaseDate<T extends object>(record: T, params: any) {
    if (params.date) return new Date(resolveValue(record, params.date));
    return new Date();
}*/