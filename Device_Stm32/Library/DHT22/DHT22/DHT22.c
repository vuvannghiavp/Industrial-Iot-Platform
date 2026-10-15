#include "DHT22.h"

static GPIO_TypeDef *wire_port;
static uint16_t wire_pin;
static GPIO_InitTypeDef gpio_init;

static void timer_config(void)
{
  RCC_ClkInitTypeDef clock_config;
  uint32_t flash_latency;
  uint32_t timer_clock;

  HAL_RCC_GetClockConfig(&clock_config, &flash_latency);
  timer_clock = HAL_RCC_GetPCLK1Freq();
  if (clock_config.APB1CLKDivider != RCC_HCLK_DIV1)
  {
    timer_clock *= 2U;
  }
  timer_clock /= 1000000U;
  if (timer_clock == 0U)
  {
    timer_clock = 1U;
  }

  __HAL_RCC_TIM3_CLK_ENABLE();
  TIM3->CR1 = TIM_CR1_OPM;
  TIM3->PSC = timer_clock - 1U;
  TIM3->ARR = 0U;
  TIM3->EGR = TIM_EGR_UG;
  TIM3->SR = 0U;
}

static void delay_us(uint32_t delay)
{
  if (delay == 0U)
  {
    return;
  }

  TIM3->CR1 = TIM_CR1_OPM;
  TIM3->ARR = delay - 1U;
  TIM3->CNT = 0U;
  TIM3->SR = 0U;
  TIM3->CR1 |= TIM_CR1_CEN;
  while ((TIM3->SR & TIM_SR_UIF) == 0U)
  {
  }
}

static uint8_t wait_for_level(GPIO_PinState level, uint16_t timeout_us)
{
  TIM3->CR1 = TIM_CR1_OPM;
  TIM3->ARR = timeout_us;
  TIM3->CNT = 0U;
  TIM3->SR = 0U;
  TIM3->CR1 |= TIM_CR1_CEN;

  while ((HAL_GPIO_ReadPin(wire_port, wire_pin) != level) &&
         ((TIM3->SR & TIM_SR_UIF) == 0U))
  {
  }

  TIM3->CR1 &= ~TIM_CR1_CEN;
  return HAL_GPIO_ReadPin(wire_port, wire_pin) == level ? 1U : 0U;
}

static void set_wire_output(void)
{
  gpio_init.Pin = wire_pin;
  gpio_init.Mode = GPIO_MODE_OUTPUT_OD;
  gpio_init.Pull = GPIO_NOPULL;
  gpio_init.Speed = GPIO_SPEED_FREQ_HIGH;
  HAL_GPIO_Init(wire_port, &gpio_init);
}

static void set_wire_input(void)
{
  gpio_init.Pin = wire_pin;
  gpio_init.Mode = GPIO_MODE_INPUT;
  gpio_init.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(wire_port, &gpio_init);
}

static void one_wire_start(void)
{
  set_wire_output();
  HAL_GPIO_WritePin(wire_port, wire_pin, GPIO_PIN_RESET);
  delay_us(1200U);
  HAL_GPIO_WritePin(wire_port, wire_pin, GPIO_PIN_SET);
  delay_us(30U);
  set_wire_input();
}

static uint8_t one_wire_response(void)
{
  return (wait_for_level(GPIO_PIN_RESET, 120U) != 0U) &&
         (wait_for_level(GPIO_PIN_SET, 100U) != 0U) &&
         (wait_for_level(GPIO_PIN_RESET, 100U) != 0U);
}

static uint8_t one_wire_read_byte(uint8_t *value)
{
  uint8_t result = 0U;
  uint8_t bit;

  for (bit = 0U; bit < 8U; bit++)
  {
    if ((wait_for_level(GPIO_PIN_RESET, 100U) == 0U) ||
        (wait_for_level(GPIO_PIN_SET, 100U) == 0U))
    {
      return 0U;
    }

    delay_us(40U);
    result <<= 1U;
    if (HAL_GPIO_ReadPin(wire_port, wire_pin) == GPIO_PIN_SET)
    {
      result |= 1U;
    }

  }

  *value = result;
  return 1U;
}

void DHT22_Init(GPIO_TypeDef *port, uint16_t pin)
{
  wire_port = port;
  wire_pin = pin;
  timer_config();
}

uint8_t DHT22_Get_Data(uint16_t *temperature, uint16_t *humidity)
{
  uint8_t data[5];
  uint8_t i;

  if ((wire_port == NULL) || (temperature == NULL) || (humidity == NULL))
  {
    return DHT22_STATUS_INVALID_ARG;
  }

  one_wire_start();
  if (one_wire_response() == 0U)
  {
    return DHT22_STATUS_TIMEOUT;
  }

  for (i = 0U; i < sizeof(data); i++)
  {
    if (one_wire_read_byte(&data[i]) == 0U)
    {
      return DHT22_STATUS_TIMEOUT;
    }
  }

  if ((uint8_t)(data[0] + data[1] + data[2] + data[3]) != data[4])
  {
    return DHT22_STATUS_CHECKSUM_ERROR;
  }

  *humidity = (uint16_t)(((uint16_t)data[0] << 8U) | data[1]);
  *temperature = (uint16_t)(((uint16_t)data[2] << 8U) | data[3]);
  return DHT22_STATUS_OK;
}
