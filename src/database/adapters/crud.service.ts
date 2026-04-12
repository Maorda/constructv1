import { NotFoundException } from '@nestjs/common';
import { BaseSheetsRepository } from '../repositories/base.sheets.repository';

// El "extends object" es la clave para que sea compatible con BaseSheetsRepository
export abstract class BaseCrudService<T extends object> {

  constructor(
    protected readonly repository: BaseSheetsRepository<T>
  ) { }

  /**
   * Crea un nuevo registro en Google Sheets
   */
  async create(data: Partial<T>): Promise<T> {
    // Obtenemos la clase de la entidad (ObreroEntity, etc.) definida en el repo hijo
    const EntityClass = (this.repository as any).EntityClass;
    const entity = new EntityClass();

    // Mapeamos los datos recibidos a la instancia de la clase
    Object.assign(entity, data);

    await this.repository.create(entity);
    return entity;
  }

  /**
   * Retorna todos los registros de la hoja (usando caché)
   */
  async findAll(): Promise<T[]> {
    return await this.repository.findAll();
  }

  /**
   * Busca un registro específico por su ID
   */
  async findOne(id: string | number): Promise<T> {
    const item = await this.repository.findById(id);

    if (!item) {
      // Intentamos obtener el nombre de la hoja para un error más claro
      const sheetName = (this.repository as any).sheetName || 'la tabla';
      throw new NotFoundException(
        `El registro con ID ${id} no fue encontrado en ${sheetName}`
      );
    }

    return item;
  }

  /**
   * Método de utilidad para forzar la limpieza de caché
   */
  async refreshCache(): Promise<void> {
    const cacheManager = (this.repository as any).cacheManager;
    const sheetName = (this.repository as any).sheetName;

    if (cacheManager && sheetName) {
      await cacheManager.del(`list:${sheetName}`);
      await cacheManager.del(`headers:${sheetName}`);
    }
  }
}