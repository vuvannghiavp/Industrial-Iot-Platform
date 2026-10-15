/*
 * DHT22.h
 *
 *  Created on: Feb 20, 2020
 *      Author: mrhause
 */
#include "stm32f1xx_hal.h"

#ifndef INC_DHT22_H_
#define INC_DHT22_H_

#define DHT22_STATUS_OK             0U
#define DHT22_STATUS_TIMEOUT        1U
#define DHT22_STATUS_CHECKSUM_ERROR 2U
#define DHT22_STATUS_INVALID_ARG    3U

/* Pass the configured GPIO port and pin to DHT22_Init(). */
void DHT22_Init(GPIO_TypeDef *port, uint16_t pin);
uint8_t DHT22_Get_Data(uint16_t *temperature, uint16_t *humidity);

#endif /* INC_DHT22_H_ */
