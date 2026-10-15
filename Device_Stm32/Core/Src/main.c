/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file           : main.c
  * @brief          : Main program body
  ******************************************************************************
  * @attention
  *
  * Copyright (c) 2026 STMicroelectronics.
  * All rights reserved.
  *
  * This software is licensed under terms that can be found in the LICENSE file
  * in the root directory of this software component.
  * If no LICENSE file comes with this software, it is provided AS-IS.
  *
  ******************************************************************************
  */
/* USER CODE END Header */
/* Includes ------------------------------------------------------------------*/
#include "main.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */
#include "bh1750.h"
#include "DHT22.h"
#include <stdint.h>

/* USER CODE END Includes */

/* Private typedef -----------------------------------------------------------*/
/* USER CODE BEGIN PTD */

/* USER CODE END PTD */

/* Private define ------------------------------------------------------------*/
/* USER CODE BEGIN PD */
#define MODBUS_SLAVE_ID             1U
#define MODBUS_MAX_FRAME_SIZE       256U
#define MODBUS_FRAME_GAP_MS         5U
#define MODBUS_REGISTER_COUNT       7U
#define SENSOR_INTERVAL_MS          3000U
#define MOTION_POLL_INTERVAL_MS     100U
#define MOTION_STARTUP_DELAY_MS     3000U
#define MOTION_DEBOUNCE_MS          300U
#define MOTION_SENSOR_HOLD_MS       5000U
#define MOTION_OFF_DELAY_MS         39000U

/* USER CODE END PD */

/* Private macro -------------------------------------------------------------*/
/* USER CODE BEGIN PM */

/* USER CODE END PM */

/* Private variables ---------------------------------------------------------*/
I2C_HandleTypeDef hi2c1;
DMA_HandleTypeDef hdma_i2c1_rx;
DMA_HandleTypeDef hdma_i2c1_tx;

UART_HandleTypeDef huart1;
DMA_HandleTypeDef hdma_usart1_tx;
DMA_HandleTypeDef hdma_usart1_rx;

/* USER CODE BEGIN PV */
typedef struct
{
  int16_t temperature_tenths;
  uint16_t humidity_tenths;
  float lux;
  uint8_t motion_detected;
  uint8_t led_on;
  uint8_t fan_on;
  uint8_t sensor_status;
} DeviceState_t;

static BH1750_HandleTypeDef bh1750;
static DeviceState_t device_state;
static uint8_t bh1750_initialized;
static uint8_t modbus_tx_error;
static uint8_t uart_rx_error;
static uint8_t uart_rx_restart_required;
static uint8_t uart_rx_dma_buffer[MODBUS_MAX_FRAME_SIZE];
static uint8_t modbus_request_buffer[MODBUS_MAX_FRAME_SIZE];
static volatile uint16_t modbus_request_length;
static volatile uint8_t modbus_request_pending;
static volatile uint32_t modbus_last_rx_tick;
static uint32_t last_sensor_read_tick;
static uint32_t last_motion_poll_tick;
static uint32_t motion_startup_tick;
static uint32_t motion_last_active_tick;
static uint32_t motion_raw_start_tick;
static uint8_t motion_raw_tracking;

/* USER CODE END PV */

/* Private function prototypes -----------------------------------------------*/
void SystemClock_Config(void);
static void MX_GPIO_Init(void);
static void MX_DMA_Init(void);
static void MX_I2C1_Init(void);
static void MX_USART1_UART_Init(void);
/* USER CODE BEGIN PFP */
static HAL_StatusTypeDef Modbus_StartReceive(void);
static void Modbus_ProcessFrame(const uint8_t *frame, uint16_t length);
static void Modbus_SendResponse(uint8_t *response, uint16_t length);
static uint16_t Modbus_CalculateCrc(const uint8_t *data, uint16_t length);
static uint16_t Modbus_GetHoldingRegister(uint16_t address);
static void Device_ReadSensors(void);
static void Device_UpdateMotion(uint32_t now);
static void Device_SetLed(uint8_t on);
static void Device_SetFan(uint8_t on);

/* USER CODE END PFP */

/* Private user code ---------------------------------------------------------*/
/* USER CODE BEGIN 0 */

/* USER CODE END 0 */

/**
  * @brief  The application entry point.
  * @retval int
  */
int main(void)
{

  /* USER CODE BEGIN 1 */

  /* USER CODE END 1 */

  /* MCU Configuration--------------------------------------------------------*/

  /* Reset of all peripherals, Initializes the Flash interface and the Systick. */
  HAL_Init();

  /* USER CODE BEGIN Init */

  /* USER CODE END Init */

  /* Configure the system clock */
  SystemClock_Config();

  /* USER CODE BEGIN SysInit */

  /* USER CODE END SysInit */

  /* Initialize all configured peripherals */
  MX_GPIO_Init();
  MX_DMA_Init();
  MX_I2C1_Init();
  MX_USART1_UART_Init();
  /* USER CODE BEGIN 2 */
  DHT22_Init(Data_DHT22_GPIO_Port, Data_DHT22_Pin);
  bh1750_initialized = (BH1750_Init(&bh1750,
                                   &hi2c1,
                                   BH1750_DEFAULT_ADDR,
                                   BH1750_MODE_CONT_HIGH_RES) == HAL_OK);

  HAL_GPIO_WritePin(RS485_DE_GPIO_Port, RS485_DE_Pin, GPIO_PIN_RESET);
  HAL_GPIO_WritePin(MOTION_LED_GPIO_Port, MOTION_LED_Pin, GPIO_PIN_RESET);
  Device_SetLed(0U);
  Device_SetFan(0U);

  if (Modbus_StartReceive() != HAL_OK)
  {
    Error_Handler();
  }

  last_sensor_read_tick = HAL_GetTick();
  motion_startup_tick = HAL_GetTick();

  /* USER CODE END 2 */

  /* Infinite loop */
  /* USER CODE BEGIN WHILE */
  while (1)
  {
    /* USER CODE END WHILE */

    /* USER CODE BEGIN 3 */
    uint32_t now = HAL_GetTick();

    if ((modbus_request_pending == 0U) && (modbus_request_length > 0U))
    {
      uint32_t primask = __get_PRIMASK();
      __disable_irq();
      now = HAL_GetTick();
      if ((modbus_request_pending == 0U) &&
          (modbus_request_length > 0U) &&
          ((uint32_t)(now - modbus_last_rx_tick) >= MODBUS_FRAME_GAP_MS))
      {
        __DMB();
        modbus_request_pending = 1U;
      }
      if (primask == 0U)
      {
        __enable_irq();
      }
    }

    if (modbus_request_pending != 0U)
    {
      __DMB();
      uint16_t request_length = modbus_request_length;
      Modbus_ProcessFrame((const uint8_t *)modbus_request_buffer, request_length);
      modbus_request_length = 0U;
      __DMB();
      modbus_request_pending = 0U;
    }

    if (uart_rx_restart_required != 0U)
    {
      uart_rx_restart_required = 0U;
      (void)HAL_UART_AbortReceive(&huart1);
      if (Modbus_StartReceive() != HAL_OK)
      {
        uart_rx_restart_required = 1U;
      }
    }

    if ((uint32_t)(now - last_sensor_read_tick) >= SENSOR_INTERVAL_MS)
    {
      last_sensor_read_tick = now;
      Device_ReadSensors();
    }

    if ((uint32_t)(now - last_motion_poll_tick) >= MOTION_POLL_INTERVAL_MS)
    {
      last_motion_poll_tick = now;
      Device_UpdateMotion(now);
    }

    HAL_Delay(1U);
  }
  /* USER CODE END 3 */
}

/**
  * @brief System Clock Configuration
  * @retval None
  */
void SystemClock_Config(void)
{
  RCC_OscInitTypeDef RCC_OscInitStruct = {0};
  RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};

  /** Initializes the RCC Oscillators according to the specified parameters
  * in the RCC_OscInitTypeDef structure.
  */
  RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSI;
  RCC_OscInitStruct.HSIState = RCC_HSI_ON;
  RCC_OscInitStruct.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;
  RCC_OscInitStruct.PLL.PLLState = RCC_PLL_NONE;
  if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK)
  {
    Error_Handler();
  }

  /** Initializes the CPU, AHB and APB buses clocks
  */
  RCC_ClkInitStruct.ClockType = RCC_CLOCKTYPE_HCLK|RCC_CLOCKTYPE_SYSCLK
                              |RCC_CLOCKTYPE_PCLK1|RCC_CLOCKTYPE_PCLK2;
  RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_HSI;
  RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
  RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV1;
  RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV1;

  if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_0) != HAL_OK)
  {
    Error_Handler();
  }
}

/**
  * @brief I2C1 Initialization Function
  * @param None
  * @retval None
  */
static void MX_I2C1_Init(void)
{

  /* USER CODE BEGIN I2C1_Init 0 */

  /* USER CODE END I2C1_Init 0 */

  /* USER CODE BEGIN I2C1_Init 1 */

  /* USER CODE END I2C1_Init 1 */
  hi2c1.Instance = I2C1;
  hi2c1.Init.ClockSpeed = 100000;
  hi2c1.Init.DutyCycle = I2C_DUTYCYCLE_2;
  hi2c1.Init.OwnAddress1 = 0;
  hi2c1.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
  hi2c1.Init.DualAddressMode = I2C_DUALADDRESS_DISABLE;
  hi2c1.Init.OwnAddress2 = 0;
  hi2c1.Init.GeneralCallMode = I2C_GENERALCALL_DISABLE;
  hi2c1.Init.NoStretchMode = I2C_NOSTRETCH_DISABLE;
  if (HAL_I2C_Init(&hi2c1) != HAL_OK)
  {
    Error_Handler();
  }
  /* USER CODE BEGIN I2C1_Init 2 */

  /* USER CODE END I2C1_Init 2 */

}

/**
  * @brief USART1 Initialization Function
  * @param None
  * @retval None
  */
static void MX_USART1_UART_Init(void)
{

  /* USER CODE BEGIN USART1_Init 0 */

  /* USER CODE END USART1_Init 0 */

  /* USER CODE BEGIN USART1_Init 1 */

  /* USER CODE END USART1_Init 1 */
  huart1.Instance = USART1;
  huart1.Init.BaudRate = 9600;
  huart1.Init.WordLength = UART_WORDLENGTH_9B;
  huart1.Init.StopBits = UART_STOPBITS_1;
  huart1.Init.Parity = UART_PARITY_EVEN;
  huart1.Init.Mode = UART_MODE_TX_RX;
  huart1.Init.HwFlowCtl = UART_HWCONTROL_NONE;
  huart1.Init.OverSampling = UART_OVERSAMPLING_16;
  if (HAL_UART_Init(&huart1) != HAL_OK)
  {
    Error_Handler();
  }
  /* USER CODE BEGIN USART1_Init 2 */

  /* USER CODE END USART1_Init 2 */

}

/**
  * Enable DMA controller clock
  */
static void MX_DMA_Init(void)
{

  /* DMA controller clock enable */
  __HAL_RCC_DMA1_CLK_ENABLE();

  /* DMA interrupt init */
  /* DMA1_Channel4_IRQn interrupt configuration */
  HAL_NVIC_SetPriority(DMA1_Channel4_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(DMA1_Channel4_IRQn);
  /* DMA1_Channel5_IRQn interrupt configuration */
  HAL_NVIC_SetPriority(DMA1_Channel5_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(DMA1_Channel5_IRQn);
  /* DMA1_Channel6_IRQn interrupt configuration */
  HAL_NVIC_SetPriority(DMA1_Channel6_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(DMA1_Channel6_IRQn);
  /* DMA1_Channel7_IRQn interrupt configuration */
  HAL_NVIC_SetPriority(DMA1_Channel7_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(DMA1_Channel7_IRQn);

}

/**
  * @brief GPIO Initialization Function
  * @param None
  * @retval None
  */
static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  /* USER CODE BEGIN MX_GPIO_Init_1 */

  /* USER CODE END MX_GPIO_Init_1 */

  /* GPIO Ports Clock Enable */
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();

  /*Configure GPIO pin Output Level */
  HAL_GPIO_WritePin(GPIOA, LED_Pin|FAN_Pin, GPIO_PIN_RESET);

  /*Configure GPIO pin Output Level */
  HAL_GPIO_WritePin(GPIOB, MOTION_LED_Pin|RS485_DE_Pin, GPIO_PIN_RESET);

  /*Configure GPIO pin : Data_DHT22_Pin */
  GPIO_InitStruct.Pin = Data_DHT22_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_INPUT;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(Data_DHT22_GPIO_Port, &GPIO_InitStruct);

  /*Configure GPIO pins : LED_Pin FAN_Pin */
  GPIO_InitStruct.Pin = LED_Pin|FAN_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);

  /*Configure GPIO pin : HC_SR522_Pin */
  GPIO_InitStruct.Pin = HC_SR522_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_INPUT;
  GPIO_InitStruct.Pull = GPIO_PULLDOWN;
  HAL_GPIO_Init(HC_SR522_GPIO_Port, &GPIO_InitStruct);

  /*Configure GPIO pins : MOTION_LED_Pin RS485_DE_Pin */
  GPIO_InitStruct.Pin = MOTION_LED_Pin|RS485_DE_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);

  /* USER CODE BEGIN MX_GPIO_Init_2 */

  /* USER CODE END MX_GPIO_Init_2 */
}

/* USER CODE BEGIN 4 */
static HAL_StatusTypeDef Modbus_StartReceive(void)
{
  HAL_StatusTypeDef status =
      HAL_UARTEx_ReceiveToIdle_DMA(&huart1, uart_rx_dma_buffer, sizeof(uart_rx_dma_buffer));
  if (status == HAL_OK)
  {
    __HAL_DMA_DISABLE_IT(huart1.hdmarx, DMA_IT_HT);
  }
  else
  {
    uart_rx_error = 1U;
  }
  return status;
}

static uint16_t Modbus_CalculateCrc(const uint8_t *data, uint16_t length)
{
  uint16_t crc = 0xFFFFU;
  uint16_t i;
  uint8_t bit;

  for (i = 0U; i < length; i++)
  {
    crc ^= data[i];
    for (bit = 0U; bit < 8U; bit++)
    {
      crc = (crc & 1U) != 0U ? (uint16_t)((crc >> 1U) ^ 0xA001U)
                             : (uint16_t)(crc >> 1U);
    }
  }
  return crc;
}

static uint16_t Modbus_GetHoldingRegister(uint16_t address)
{
  switch (address)
  {
    case 0U:
      return (uint16_t)device_state.temperature_tenths;
    case 1U:
      return device_state.humidity_tenths;
    case 2U:
      if (device_state.lux >= 65535.0f)
      {
        return 65535U;
      }
      return device_state.lux > 0.0f ? (uint16_t)(device_state.lux + 0.5f) : 0U;
    case 3U:
      return device_state.motion_detected != 0U ? 1U : 0U;
    case 4U:
      return device_state.led_on != 0U ? 1U : 0U;
    case 5U:
      return device_state.fan_on != 0U ? 1U : 0U;
    case 6U:
      return (uint16_t)(device_state.sensor_status |
                        (modbus_tx_error << 2U) |
                        (uart_rx_error << 3U));
    default:
      return 0U;
  }
}

static void Device_SetLed(uint8_t on)
{
  device_state.led_on = on != 0U ? 1U : 0U;
  HAL_GPIO_WritePin(LED_GPIO_Port, LED_Pin,
                    device_state.led_on != 0U ? GPIO_PIN_SET : GPIO_PIN_RESET);
}

static void Device_SetFan(uint8_t on)
{
  device_state.fan_on = on != 0U ? 1U : 0U;
  HAL_GPIO_WritePin(FAN_GPIO_Port, FAN_Pin,
                    device_state.fan_on != 0U ? GPIO_PIN_SET : GPIO_PIN_RESET);
}

static void Device_ReadSensors(void)
{
  uint8_t status = 0U;
  uint16_t temperature_raw = 0U;
  uint16_t humidity_raw = 0U;

  if (DHT22_Get_Data(&temperature_raw, &humidity_raw) == DHT22_STATUS_OK)
  {
    int16_t temperature = (int16_t)(temperature_raw & 0x7FFFU);
    if ((temperature_raw & 0x8000U) != 0U)
    {
      temperature = (int16_t)-temperature;
    }
    device_state.temperature_tenths = temperature;
    device_state.humidity_tenths = humidity_raw;
    status |= 0x0001U;
  }

  if (bh1750_initialized == 0U)
  {
    bh1750_initialized = (BH1750_Init(&bh1750,
                                     &hi2c1,
                                     BH1750_DEFAULT_ADDR,
                                     BH1750_MODE_CONT_HIGH_RES) == HAL_OK);
  }

  if ((bh1750_initialized != 0U) &&
      (BH1750_IsMeasurementReady(&bh1750) != 0U))
  {
    uint8_t data[2];
    if (HAL_I2C_Master_Receive(&hi2c1,
                               BH1750_DEFAULT_ADDR,
                               data,
                               sizeof(data),
                               BH1750_I2C_TIMEOUT_MS) == HAL_OK)
    {
      uint16_t raw_lux = (uint16_t)(((uint16_t)data[0] << 8U) | data[1]);
      device_state.lux = (float)raw_lux / BH1750_CONV_FACTOR;
      status |= 0x0002U;
    }
  }

  device_state.sensor_status = status;
}

static void Device_UpdateMotion(uint32_t now)
{
  if ((uint32_t)(now - motion_startup_tick) < MOTION_STARTUP_DELAY_MS)
  {
    return;
  }

  if (HAL_GPIO_ReadPin(HC_SR522_GPIO_Port, HC_SR522_Pin) == GPIO_PIN_SET)
  {
    if (motion_raw_tracking == 0U)
    {
      motion_raw_tracking = 1U;
      motion_raw_start_tick = now;
    }
    motion_last_active_tick = now;
    if ((uint32_t)(now - motion_raw_start_tick) >= MOTION_DEBOUNCE_MS)
    {
      device_state.motion_detected = 1U;
    }
  }
  else
  {
    motion_raw_tracking = 0U;
    if ((device_state.motion_detected != 0U) &&
        ((uint32_t)(now - motion_last_active_tick) >=
         (MOTION_SENSOR_HOLD_MS + MOTION_OFF_DELAY_MS)))
    {
      device_state.motion_detected = 0U;
    }
  }

  HAL_GPIO_WritePin(MOTION_LED_GPIO_Port, MOTION_LED_Pin,
                    device_state.motion_detected != 0U ? GPIO_PIN_SET : GPIO_PIN_RESET);
}

static void Modbus_SendResponse(uint8_t *response, uint16_t length)
{
  uint16_t crc = Modbus_CalculateCrc(response, length);
  response[length++] = (uint8_t)(crc & 0x00FFU);
  response[length++] = (uint8_t)(crc >> 8U);

  HAL_GPIO_WritePin(RS485_DE_GPIO_Port, RS485_DE_Pin, GPIO_PIN_SET);
  if (HAL_UART_Transmit(&huart1, response, length, 100U) != HAL_OK)
  {
    modbus_tx_error = 1U;
  }
  HAL_GPIO_WritePin(RS485_DE_GPIO_Port, RS485_DE_Pin, GPIO_PIN_RESET);
}

static void Modbus_ProcessFrame(const uint8_t *frame, uint16_t length)
{
  uint8_t response[MODBUS_MAX_FRAME_SIZE];
  uint16_t crc;
  uint8_t function;
  uint16_t response_length = 0U;

  if ((length < 4U) || (length > MODBUS_MAX_FRAME_SIZE))
  {
    return;
  }

  crc = (uint16_t)frame[length - 2U] |
        (uint16_t)((uint16_t)frame[length - 1U] << 8U);
  if (Modbus_CalculateCrc(frame, (uint16_t)(length - 2U)) != crc)
  {
    return;
  }
  if (frame[0] != MODBUS_SLAVE_ID)
  {
    return;
  }

  function = frame[1];
  response[0] = MODBUS_SLAVE_ID;
  response[1] = function;

  if (function == 0x03U)
  {
    uint16_t start;
    uint16_t count;
    uint16_t i;

    if (length != 8U)
    {
      response[1] = (uint8_t)(function | 0x80U);
      response[2] = 0x03U;
      response_length = 3U;
    }
    else
    {
      start = (uint16_t)(((uint16_t)frame[2] << 8U) | frame[3]);
      count = (uint16_t)(((uint16_t)frame[4] << 8U) | frame[5]);
      if ((count == 0U) || (count > 125U))
      {
        response[1] = (uint8_t)(function | 0x80U);
        response[2] = 0x03U;
        response_length = 3U;
      }
      else if ((start >= MODBUS_REGISTER_COUNT) ||
               (count > (MODBUS_REGISTER_COUNT - start)))
      {
        response[1] = (uint8_t)(function | 0x80U);
        response[2] = 0x02U;
        response_length = 3U;
      }
      else
      {
        response[2] = (uint8_t)(count * 2U);
        for (i = 0U; i < count; i++)
        {
          uint16_t value = Modbus_GetHoldingRegister((uint16_t)(start + i));
          response[3U + (i * 2U)] = (uint8_t)(value >> 8U);
          response[4U + (i * 2U)] = (uint8_t)(value & 0x00FFU);
        }
        response_length = (uint16_t)(3U + (count * 2U));
      }
    }
  }
  else if (function == 0x06U)
  {
    uint16_t address;
    uint16_t value;

    if (length != 8U)
    {
      response[1] = (uint8_t)(function | 0x80U);
      response[2] = 0x03U;
      response_length = 3U;
    }
    else
    {
      address = (uint16_t)(((uint16_t)frame[2] << 8U) | frame[3]);
      value = (uint16_t)(((uint16_t)frame[4] << 8U) | frame[5]);
      if ((address != 4U) && (address != 5U))
      {
        response[1] = (uint8_t)(function | 0x80U);
        response[2] = 0x02U;
        response_length = 3U;
      }
      else if (value > 1U)
      {
        response[1] = (uint8_t)(function | 0x80U);
        response[2] = 0x03U;
        response_length = 3U;
      }
      else
      {
        if (address == 4U)
        {
          Device_SetLed((uint8_t)value);
        }
        else
        {
          Device_SetFan((uint8_t)value);
        }
        for (response_length = 0U; response_length < 6U; response_length++)
        {
          response[response_length] = frame[response_length];
        }
      }
    }
  }
  else
  {
    response[1] = (uint8_t)(function | 0x80U);
    response[2] = 0x01U;
    response_length = 3U;
  }

  if (response_length != 0U)
  {
    Modbus_SendResponse(response, response_length);
  }
}

void HAL_UARTEx_RxEventCallback(UART_HandleTypeDef *huart, uint16_t size)
{
  uint16_t i;

  if (huart->Instance != USART1)
  {
    return;
  }

  if ((size > 0U) && (modbus_request_pending == 0U) &&
      (size <= (MODBUS_MAX_FRAME_SIZE - modbus_request_length)))
  {
    for (i = 0U; i < size; i++)
    {
      modbus_request_buffer[modbus_request_length + i] = uart_rx_dma_buffer[i];
    }
    modbus_request_length = (uint16_t)(modbus_request_length + size);
    modbus_last_rx_tick = HAL_GetTick();
  }
  else if (size > 0U)
  {
    uart_rx_error = 1U;
    if (modbus_request_pending == 0U)
    {
      modbus_request_length = 0U;
    }
  }

  if (Modbus_StartReceive() != HAL_OK)
  {
    uart_rx_restart_required = 1U;
  }
}

void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart)
{
  if (huart->Instance == USART1)
  {
    uart_rx_error = 1U;
    uart_rx_restart_required = 1U;
  }
}

/* USER CODE END 4 */

/**
  * @brief  This function is executed in case of error occurrence.
  * @retval None
  */
void Error_Handler(void)
{
  /* USER CODE BEGIN Error_Handler_Debug */
  /* User can add his own implementation to report the HAL error return state */
  __disable_irq();
  while (1)
  {
  }
  /* USER CODE END Error_Handler_Debug */
}
#ifdef USE_FULL_ASSERT
/**
  * @brief  Reports the name of the source file and the source line number
  *         where the assert_param error has occurred.
  * @param  file: pointer to the source file name
  * @param  line: assert_param error line source number
  * @retval None
  */
void assert_failed(uint8_t *file, uint32_t line)
{
  /* USER CODE BEGIN 6 */
  /* User can add his own implementation to report the file name and line number,
     ex: printf("Wrong parameters value: file %s on line %d\r\n", file, line) */
  /* USER CODE END 6 */
}
#endif /* USE_FULL_ASSERT */
