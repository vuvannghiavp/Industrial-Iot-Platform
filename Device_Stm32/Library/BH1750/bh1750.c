/**
 * @file    bh1750.c
 * @brief   Mã nguồn thư viện cảm biến ánh sáng BH1750FVI cho STM32 HAL.
 */

#include "bh1750.h"

static uint8_t BH1750_IsValidMode(BH1750_Mode_t mode)
{
    switch (mode) {
    case BH1750_MODE_CONT_HIGH_RES:
    case BH1750_MODE_CONT_HIGH_RES2:
    case BH1750_MODE_CONT_LOW_RES:
    case BH1750_MODE_ONETIME_HIGH_RES:
    case BH1750_MODE_ONETIME_HIGH_RES2:
    case BH1750_MODE_ONETIME_LOW_RES:
        return 1U;
    default:
        return 0U;
    }
}

static uint8_t BH1750_IsOneTimeMode(BH1750_Mode_t mode)
{
    return ((mode == BH1750_MODE_ONETIME_HIGH_RES) ||
            (mode == BH1750_MODE_ONETIME_HIGH_RES2) ||
            (mode == BH1750_MODE_ONETIME_LOW_RES)) ? 1U : 0U;
}

static uint8_t BH1750_IsValidAddress(uint16_t dev_addr)
{
    return ((dev_addr == BH1750_ADDR_GND) || (dev_addr == BH1750_ADDR_VCC)) ? 1U : 0U;
}

static void BH1750_MarkConversionStarted(BH1750_HandleTypeDef *hbh)
{
    hbh->conversion_start_tick = HAL_GetTick();
    hbh->conversion_pending = 1U;
    hbh->data_ready = 0U;
}

/**
 * @brief  Gửi 1 byte lệnh tới BH1750 ở chế độ Polling (dùng lúc khởi tạo)
 */
HAL_StatusTypeDef BH1750_SendCommand(BH1750_HandleTypeDef *hbh, uint8_t cmd)
{
    if ((hbh == NULL) || (hbh->hi2c == NULL)) {
        return HAL_ERROR;
    }
    if ((hbh->dma_tx_busy != 0U) || (HAL_I2C_GetState(hbh->hi2c) != HAL_I2C_STATE_READY)) {
        return HAL_BUSY;
    }

    hbh->tx_cmd = cmd;
    return HAL_I2C_Master_Transmit(hbh->hi2c,
                                   hbh->dev_addr,
                                   &hbh->tx_cmd,
                                   1U,
                                   BH1750_I2C_TIMEOUT_MS);
}

/**
 * @brief  Gửi 1 byte lệnh tới BH1750 bằng DMA (Non-blocking)
 */
HAL_StatusTypeDef BH1750_SendCommand_DMA(BH1750_HandleTypeDef *hbh, uint8_t cmd)
{
    if ((hbh == NULL) || (hbh->hi2c == NULL)) {
        return HAL_ERROR;
    }
    if ((hbh->dma_tx_busy != 0U) || (hbh->dma_rx_busy != 0U) ||
        (HAL_I2C_GetState(hbh->hi2c) != HAL_I2C_STATE_READY)) {
        return HAL_BUSY;
    }

    hbh->tx_cmd = cmd;
    hbh->dma_tx_busy = 1U;
    hbh->measurement_tx_pending = BH1750_IsValidMode((BH1750_Mode_t)cmd);
    HAL_StatusTypeDef status = HAL_I2C_Master_Transmit_DMA(hbh->hi2c,
                                                           hbh->dev_addr,
                                                           &hbh->tx_cmd,
                                                           1U);
    if (status != HAL_OK) {
        hbh->dma_tx_busy = 0U;
        hbh->measurement_tx_pending = 0U;
    }
    return status;
}

uint16_t BH1750_GetMeasurementTimeMs(BH1750_Mode_t mode)
{
    switch (mode) {
    case BH1750_MODE_CONT_LOW_RES:
    case BH1750_MODE_ONETIME_LOW_RES:
        return 24U;
    case BH1750_MODE_CONT_HIGH_RES:
    case BH1750_MODE_CONT_HIGH_RES2:
    case BH1750_MODE_ONETIME_HIGH_RES:
    case BH1750_MODE_ONETIME_HIGH_RES2:
        return 180U;
    default:
        return 0U;
    }
}

/**
 * @brief  Thay đổi chế độ đo của BH1750
 */
HAL_StatusTypeDef BH1750_SetMode(BH1750_HandleTypeDef *hbh, BH1750_Mode_t mode)
{
    if ((hbh == NULL) || (hbh->hi2c == NULL) || (BH1750_IsValidMode(mode) == 0U)) {
        return HAL_ERROR;
    }

    HAL_StatusTypeDef status = BH1750_SendCommand(hbh, (uint8_t)mode);
    if (status == HAL_OK) {
        hbh->mode = mode;
        BH1750_MarkConversionStarted(hbh);
    }
    return status;
}

/**
 * @brief  Khởi tạo cảm biến BH1750
 */
HAL_StatusTypeDef BH1750_Init(BH1750_HandleTypeDef *hbh,
                              I2C_HandleTypeDef *hi2c,
                              uint16_t dev_addr,
                              BH1750_Mode_t mode)
{
    if ((hbh == NULL) || (hi2c == NULL) ||
        (BH1750_IsValidAddress(dev_addr) == 0U) ||
        (BH1750_IsValidMode(mode) == 0U)) {
        return HAL_ERROR;
    }

    hbh->hi2c        = hi2c;
    hbh->dev_addr    = dev_addr;
    hbh->mode        = mode;
    hbh->tx_cmd      = 0U;
    hbh->rx_buf[0]   = 0U;
    hbh->rx_buf[1]   = 0U;
    hbh->dma_rx_busy = 0U;
    hbh->dma_tx_busy = 0U;
    hbh->data_ready  = 0U;
    hbh->raw_data    = 0U;
    hbh->lux         = 0.0f;
    hbh->conversion_pending = 0U;
    hbh->measurement_tx_pending = 0U;
    hbh->conversion_start_tick = 0U;

    /* Kiểm tra kết nối phần cứng trên bus I2C trước khi gửi lệnh */
    HAL_StatusTypeDef status = HAL_I2C_IsDeviceReady(hbh->hi2c,
                                                     hbh->dev_addr,
                                                     3U,
                                                     BH1750_I2C_TIMEOUT_MS);
    if (status != HAL_OK) {
        return status;
    }

    /* Bước 1: Bật nguồn cảm biến (Power On) */
    status = BH1750_SendCommand(hbh, BH1750_CMD_POWER_ON);
    if (status != HAL_OK) {
        return status;
    }
    HAL_Delay(10U);

    /* Bước 2: Xóa thanh ghi dữ liệu cũ (Reset) */
    status = BH1750_SendCommand(hbh, BH1750_CMD_RESET);
    if (status != HAL_OK) {
        return status;
    }

    /* Bước 3: Cài đặt chế độ đo mong muốn */
    status = BH1750_SetMode(hbh, mode);
    if (status != HAL_OK) {
        return status;
    }

    return HAL_OK;
}

/**
 * @brief  Kích hoạt đọc 2 byte dữ liệu từ BH1750 qua I2C DMA
 */
HAL_StatusTypeDef BH1750_StartRead_DMA(BH1750_HandleTypeDef *hbh)
{
    if ((hbh == NULL) || (hbh->hi2c == NULL)) {
        return HAL_ERROR;
    }

    if (BH1750_IsValidMode(hbh->mode) == 0U) {
        return HAL_ERROR;
    }
    if ((hbh->dma_rx_busy != 0U) || (hbh->dma_tx_busy != 0U) ||
        (hbh->data_ready != 0U) || (HAL_I2C_GetState(hbh->hi2c) != HAL_I2C_STATE_READY)) {
        return HAL_BUSY;
    }
    if (hbh->conversion_pending != 0U) {
        uint32_t elapsed = HAL_GetTick() - hbh->conversion_start_tick;
        if (elapsed < (uint32_t)BH1750_GetMeasurementTimeMs(hbh->mode)) {
            return HAL_BUSY;
        }
    } else if (BH1750_IsOneTimeMode(hbh->mode) != 0U) {
        return HAL_BUSY;
    }

    hbh->dma_rx_busy = 1U;

    HAL_StatusTypeDef status = HAL_I2C_Master_Receive_DMA(hbh->hi2c,
                                                          hbh->dev_addr,
                                                          hbh->rx_buf,
                                                          2U);
    if (status != HAL_OK) {
        hbh->dma_rx_busy = 0U;
    }

    return status;
}

HAL_StatusTypeDef BH1750_StartMeasurement_DMA(BH1750_HandleTypeDef *hbh)
{
    if ((hbh == NULL) || (hbh->hi2c == NULL) ||
        (BH1750_IsValidMode(hbh->mode) == 0U) ||
        (BH1750_IsOneTimeMode(hbh->mode) == 0U)) {
        return HAL_ERROR;
    }
    if ((hbh->conversion_pending != 0U) || (hbh->data_ready != 0U) ||
        (hbh->dma_tx_busy != 0U) || (hbh->dma_rx_busy != 0U) ||
        (HAL_I2C_GetState(hbh->hi2c) != HAL_I2C_STATE_READY)) {
        return HAL_BUSY;
    }

    return BH1750_SendCommand_DMA(hbh, (uint8_t)hbh->mode);
}

uint8_t BH1750_IsMeasurementReady(BH1750_HandleTypeDef *hbh)
{
    if ((hbh == NULL) || (BH1750_IsValidMode(hbh->mode) == 0U)) {
        return 0U;
    }
    if (hbh->conversion_pending == 0U) {
        return (BH1750_IsOneTimeMode(hbh->mode) == 0U) ? 1U : 0U;
    }
    return ((HAL_GetTick() - hbh->conversion_start_tick) >=
            (uint32_t)BH1750_GetMeasurementTimeMs(hbh->mode)) ? 1U : 0U;
}

/**
 * @brief  Ghép byte dữ liệu khi nhận I2C DMA hoàn tất.
 */
void BH1750_DMA_RxCpltHandler(BH1750_HandleTypeDef *hbh, I2C_HandleTypeDef *hi2c)
{
    if ((hbh == NULL) || (hi2c == NULL) || (hbh->hi2c == NULL)) {
        return;
    }

    if ((hi2c->Instance == hbh->hi2c->Instance) && (hbh->dma_rx_busy != 0U)) {
        uint16_t raw = ((uint16_t)hbh->rx_buf[0] << 8) | (uint16_t)hbh->rx_buf[1];
        hbh->raw_data = raw;
        hbh->dma_rx_busy = 0U;
        hbh->data_ready  = 1U;
        hbh->conversion_pending = 0U;
    }
}

void BH1750_DMA_TxCpltHandler(BH1750_HandleTypeDef *hbh, I2C_HandleTypeDef *hi2c)
{
    if ((hbh == NULL) || (hi2c == NULL) || (hbh->hi2c == NULL)) {
        return;
    }

    if ((hi2c->Instance == hbh->hi2c->Instance) && (hbh->dma_tx_busy != 0U)) {
        hbh->dma_tx_busy = 0U;
        if (hbh->measurement_tx_pending != 0U) {
            hbh->measurement_tx_pending = 0U;
            hbh->mode = (BH1750_Mode_t)hbh->tx_cmd;
            BH1750_MarkConversionStarted(hbh);
        }
    }
}

/**
 * @brief  Xử lý khi xảy ra lỗi trên bus I2C/DMA để tránh treo cờ dma_rx_busy
 */
void BH1750_DMA_ErrorHandler(BH1750_HandleTypeDef *hbh, I2C_HandleTypeDef *hi2c)
{
    if ((hbh == NULL) || (hi2c == NULL) || (hbh->hi2c == NULL)) {
        return;
    }

    if (hi2c->Instance == hbh->hi2c->Instance) {
        hbh->dma_rx_busy = 0U;
        hbh->dma_tx_busy = 0U;
        if (hbh->measurement_tx_pending != 0U) {
            hbh->measurement_tx_pending = 0U;
            hbh->conversion_pending = 0U;
        }
    }
}

/**
 * @brief  Kiểm tra cờ dữ liệu mới
 */
uint8_t BH1750_IsDataReady(BH1750_HandleTypeDef *hbh)
{
    if (hbh == NULL) {
        return 0U;
    }
    return hbh->data_ready;
}

/**
 * @brief  Đọc giá trị Lux mới nhất và xóa cờ data_ready
 */
float BH1750_GetLux(BH1750_HandleTypeDef *hbh)
{
    if (hbh == NULL) {
        return 0.0f;
    }
    float calculated_lux = (float)hbh->raw_data / BH1750_CONV_FACTOR;
    if ((hbh->mode == BH1750_MODE_CONT_HIGH_RES2) ||
        (hbh->mode == BH1750_MODE_ONETIME_HIGH_RES2)) {
        calculated_lux *= 0.5f;
    }
    hbh->lux = calculated_lux;
    hbh->data_ready = 0U;
    return hbh->lux;
}

/* ==========================================================================
 * VÍ DỤ TÍCH HỢP VÀO FILE main.c (STM32CubeIDE - STM32F103C8T6)
 * ==========================================================================
 *
 * #include "bh1750.h"
 *
 * extern I2C_HandleTypeDef hi2c1;
 * BH1750_HandleTypeDef hbh1750;
 * float current_lux = 0.0f;
 * uint32_t last_read_tick = 0U;
 * HAL_StatusTypeDef bh1750_status;
 *
 * // 1. Đặt hàm callback ngắt I2C DMA ở phần USER CODE BEGIN 4 trong main.c:
 * void HAL_I2C_MasterRxCpltCallback(I2C_HandleTypeDef *hi2c)
 * {
 *     BH1750_DMA_RxCpltHandler(&hbh1750, hi2c);
 * }
 *
 * void HAL_I2C_MasterTxCpltCallback(I2C_HandleTypeDef *hi2c)
 * {
 *     BH1750_DMA_TxCpltHandler(&hbh1750, hi2c);
 * }
 *
 * void HAL_I2C_ErrorCallback(I2C_HandleTypeDef *hi2c)
 * {
 *     BH1750_DMA_ErrorHandler(&hbh1750, hi2c);
 * }
 *
 * // 2. Trong hàm main(), sau khi gọi MX_DMA_Init() và MX_I2C1_Init():
 * if (BH1750_Init(&hbh1750, &hi2c1, BH1750_ADDR_GND,
 *                 BH1750_MODE_CONT_HIGH_RES) != HAL_OK)
 * {
 *     Error_Handler();
 * }
 *
 * // 3. Trong vòng lặp while (1):
 * while (1)
 * {
 *     // Định kỳ mỗi 200ms kích hoạt DMA đọc 2 byte (không làm trễ CPU)
 *     if (HAL_GetTick() - last_read_tick >= 200U)
 *     {
 *         last_read_tick = HAL_GetTick();
 *         bh1750_status = BH1750_StartRead_DMA(&hbh1750);
 *         if ((bh1750_status != HAL_OK) && (bh1750_status != HAL_BUSY))
 *         {
 *             Error_Handler();
 *         }
 *     }
 *
 *     // Khi DMA nhận xong 2 byte, cờ data_ready tự bật lên 1
 *     if (BH1750_IsDataReady(&hbh1750))
 *     {
 *         current_lux = BH1750_GetLux(&hbh1750);
 *         // Xử lý giá trị current_lux tại đây (hiển thị LCD, gửi UART, v.v.)
 *     }
 * }
 *
 * // Với One-Time, sau khi đọc xong dữ liệu và gọi BH1750_GetLux():
 * // 1. BH1750_StartMeasurement_DMA(&hbh1750)
 * // 2. Chờ BH1750_IsMeasurementReady() khác 0
 * // 3. BH1750_StartRead_DMA(), rồi xử lý dữ liệu khi BH1750_IsDataReady()
 * ========================================================================== */