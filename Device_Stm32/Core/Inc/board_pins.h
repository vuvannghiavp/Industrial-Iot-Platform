#ifndef BOARD_PINS_H
#define BOARD_PINS_H

#include "stm32f1xx_hal.h"

/* Application GPIO assignments. Keep each pin and port paired. */
#define BOARD_DHT22_Pin       GPIO_PIN_1
#define BOARD_DHT22_GPIO_Port GPIOA

#define BOARD_LED_Pin         GPIO_PIN_2
#define BOARD_LED_GPIO_Port   GPIOA

#define BOARD_FAN_Pin         GPIO_PIN_3
#define BOARD_FAN_GPIO_Port   GPIOA

#define BOARD_HC_SR522_Pin       GPIO_PIN_0
#define BOARD_HC_SR522_GPIO_Port GPIOB

#define BOARD_MOTION_LED_Pin       GPIO_PIN_1
#define BOARD_MOTION_LED_GPIO_Port GPIOB

#define BOARD_RS485_DE_Pin       GPIO_PIN_10
#define BOARD_RS485_DE_GPIO_Port GPIOB

/* Available GPIO ports on the STM32F103C8 used by this project. */
#define BOARD_GPIO_CLOCK_ENABLE() \
    do { \
        __HAL_RCC_GPIOA_CLK_ENABLE(); \
        __HAL_RCC_GPIOB_CLK_ENABLE(); \
        __HAL_RCC_GPIOC_CLK_ENABLE(); \
    } while (0)

#endif /* BOARD_PINS_H */
